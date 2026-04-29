/**
 * Nuzlocke AI — Competitive
 *
 * Move selection via MCTS (UCB1 bandit over root moves, formula-based rollouts).
 * Voluntary switching via depth-1 minimax (fast enough, switching is less
 * sensitive to deep lookahead than move selection).
 *
 * No hardcoded move scores. Multi-turn payoffs (hazards, status, setup) emerge
 * from rollout statistics rather than explicit heuristics.
 */

import type { Battle } from '../battle';
import type { Pokemon } from '../pokemon';
import type { ChoiceRequest } from '../side';
import { NuzlockeAI } from './base';
import { PositionEvaluator, projectMoveState, snapshotState } from './evaluator';
import { initRolloutState, type RolloutState } from './rollout';
import { MCTSEngine } from './mcts';
import { isAbilityImmune } from './calculator';

const PROTECT_IDS = new Set(['protect', 'kingsshield', 'spikyshield', 'banefulbunker']);
const TRAP_IDS = new Set(['block', 'meanlook', 'spiderweb']);

// ─── Action descriptors (used for voluntary switch depth-1 eval) ──────────────

interface MoveAction { kind: 'move'; slot: number; move: Move; }
interface SwitchAction { kind: 'switch'; slot: number; pokemon: Pokemon; }
type Action = MoveAction | SwitchAction;

// ─── CompetitiveAI ────────────────────────────────────────────────────────────

export class CompetitiveAI extends NuzlockeAI {
	private evaluator: PositionEvaluator;
	/**
	 * ID of the move we chose last turn, keyed by Pokemon slot index.
	 * Used for consecutive-Protect detection (more reliable than pokemon.lastMove
	 * which may not be populated at choice time in this format).
	 */
	private lastChoiceBySlot: Map<number, string> = new Map();

	constructor(battle: Battle) {
		super(battle);
		this.evaluator = new PositionEvaluator(battle);
	}

	// =========================================================================
	// Move selection — MCTS
	// =========================================================================

	protected override chooseMove(request: ChoiceRequest): string {
		const ai = this.battle.sides[1].active[0];
		const opp = this.battle.sides[0].active[0];
		if (!ai || !opp) {
			// @ts-expect-error jank request parser
			return `move ${this.battle.random(1, request.active[0].moves.length + 1)}`;
		}

		// Build rollout state first — it reads hazards/status correctly and we
		// pass it into the filter so both use the same snapshot.
		const initialState = initRolloutState(this.battle);

		const aiSlot = this.battle.sides[1].pokemon.indexOf(ai);
		const lastChosenId = this.lastChoiceBySlot.get(aiSlot) ?? '';

		const candidateMoves = this.getCandidateMoves(request, initialState, lastChosenId);
		if (candidateMoves.length === 0) return 'move 1';
		if (candidateMoves.length === 1) {
			this.lastChoiceBySlot.set(aiSlot, candidateMoves[0].move.id);
			return `move ${candidateMoves[0].slot}`;
		}

		const engine = new MCTSEngine(this.battle);
		// slot is 1-indexed; MCTSEngine works with 0-based moveSlot indices
		const candidateIndices = candidateMoves.map(m => m.slot - 1);
		const bestIdx = engine.selectMove(initialState, candidateIndices);

		// Record what we chose (slot index → move id) for next turn's Protect check
		const chosenMove = candidateMoves.find(m => m.slot === bestIdx + 1);
		this.lastChoiceBySlot.set(aiSlot, chosenMove?.move.id ?? '');

		return `move ${bestIdx + 1}`;
	}

	// =========================================================================
	// Voluntary switching — depth-1 minimax
	// Switching is less sensitive to deep lookahead than move selection,
	// so depth-1 is sufficient and avoids doubling the MCTS budget.
	// =========================================================================

	protected override considerVoluntarySwitch(request: ChoiceRequest): string | null {
		// @ts-expect-error jank request parser
		if (request.active?.[0]?.trapped) return null;
		const ai = this.battle.sides[1].active[0];
		const opp = this.battle.sides[0].active[0];
		if (!ai || !opp) return null;

		const oppOptions = this.getOpponentOptions(opp);

		// Score of staying in: best move we can use vs worst opponent response
		const stayInScore = this.minMaxScore(ai, opp, oppOptions);

		// Score of each bench option.
		// Evaluated at the same depth as stayInScore: pivot hit cost + one turn of
		// fighting with the switch-in. Without this, a fresh bench mon always looks
		// artificially good (more HP than the beaten-up active) regardless of whether
		// it can actually turn the position around.
		let bestSwitchScore = -Infinity;
		let bestSlot = -1;

		const bench = this.battle.sides[1].pokemon;
		for (let i = 1; i < bench.length; i++) {
			const p = bench[i];
			if (!p || p.fainted || p.hp <= 0) continue;

			// Pivot hit: opponent's best move against this switch-in (in evaluator units).
			const pivotOppMove = this.getBestMoveAgainst(opp, p);
			let pivotCost = 0;
			if (pivotOppMove.basePower > 0 && this.battle.dex.getImmunity(pivotOppMove.type, p.types)) {
				const { damage } = this.simulateDamage(pivotOppMove, opp, p);
				pivotCost = (damage / p.maxhp) * 100;
			}

			// Expected score one turn after switching in (bench mon fights back).
			// Uses the same minimax as stayInScore so depth is symmetric.
			const benchNextTurn = this.minMaxScore(p, opp, oppOptions);
			const switchScore = benchNextTurn - pivotCost;

			if (switchScore > bestSwitchScore) {
				bestSwitchScore = switchScore;
				bestSlot = i + 1;
			}
		}

		// Only switch if bench is meaningfully better (>10 pts avoids thrashing)
		if (bestSlot !== -1 && bestSwitchScore > stayInScore + 10) {
			return `switch ${bestSlot}`;
		}
		return null;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/** Depth-1 minimax score for staying in (used by considerVoluntarySwitch). */
	private minMaxScore(ai: Pokemon, opp: Pokemon, oppOptions: Action[]): number {
		const aiMoves = ai.moveSlots
			.map((slot, i) => ({ slot: i + 1, move: this.battle.dex.moves.get(slot.id) }))
			.filter(({ move }) => move.basePower > 0 &&
				this.battle.dex.getImmunity(move.type, opp.types) &&
				!isAbilityImmune(ai.ability as string, opp.ability as string, move.type));

		if (aiMoves.length === 0) {
			// No effective damaging moves (e.g. dedicated wall) — score the position
			// as-is rather than -Infinity, which would force an unnecessary switch.
			return this.evaluator.evaluate(snapshotState(this.battle, ai, opp));
		}

		let bestMinScore = -Infinity;
		for (const { move: aiMove } of aiMoves) {
			let minScore = Infinity;
			for (const oppAction of oppOptions) {
				const oppMove = oppAction.kind === 'move' ? oppAction.move : this.getBestMoveAgainst(opp, ai);
				const state = projectMoveState(this.battle, ai, opp, aiMove, oppMove);
				const score = this.evaluator.evaluate(state);
				if (score < minScore) minScore = score;
			}
			if (minScore > bestMinScore) bestMinScore = minScore;
		}
		return bestMinScore;
	}

	/** Candidate AI moves: excludes disabled, zero-PP moves, and clearly useless moves. */
	private getCandidateMoves(
		request: ChoiceRequest,
		state: RolloutState,
		lastChosenId: string
	): MoveAction[] {
		// @ts-expect-error jank request parser
		const moves = request.active[0].moves as Array<{id: string, disabled: boolean | string, pp: number}>;
		const actions: MoveAction[] = [];
		for (let i = 0; i < moves.length; i++) {
			const m = moves[i];
			if (m.disabled || m.pp === 0) continue;
			const move = this.battle.dex.moves.get(m.id);
			actions.push({ kind: 'move', slot: i + 1, move });
		}
		return this.filterUselessMoves(actions, state, lastChosenId);
	}

	/**
	 * Removes moves that are guaranteed to have no useful effect this turn.
	 * Uses the rollout state snapshot (known-correct at choice time) rather than
	 * reading from battle directly, which can be stale in this async format.
	 * Keeps at least one move (never filters down to empty).
	 */
	private filterUselessMoves(
		candidates: MoveAction[],
		state: RolloutState,
		lastChosenId: string
	): MoveAction[] {
		const opp = this.battle.sides[0].active[0];
		if (!opp) return candidates;

		const oppMon = state.opp[state.oppActiveIdx];
		const hazards = state.hazardsOnOppSide;
		const oppHasStatus = !!oppMon.status;
		const oppIsTrapped = !!opp.volatiles['trapped'];
		const lastWasProtect = PROTECT_IDS.has(lastChosenId);

		const ai = this.battle.sides[1].active[0];

		// Detect whether AI is about to be KO'd so it doesn't waste turns on self-buffs.
		let dyingThisTurn = false;
		let likelyDyingSoon = false;
		if (ai) {
			const oppBestMove = this.getBestMoveAgainst(opp, ai);
			if (oppBestMove.basePower > 0 && this.battle.dex.getImmunity(oppBestMove.type, ai.types)) {
				const { damage } = this.simulateDamage(oppBestMove, opp, ai);
				const oppGoesFirst = !this.isFaster(ai, opp);
				// Dying this turn: opponent is faster AND their hit kills outright.
				dyingThisTurn = oppGoesFirst && damage >= ai.hp;
				// Dying soon: low HP and opponent hits hard enough to finish in ~2 turns.
				likelyDyingSoon = (ai.hp / ai.maxhp < 0.40) && (damage / ai.maxhp >= 0.35);
			}
		}

		const filtered = candidates.filter(({ move }) => {
			// Immune moves: type or ability makes the move deal zero damage
			if (move.basePower > 0 && !this.battle.dex.getImmunity(move.type, opp.types)) return false;
			if (move.basePower > 0 && isAbilityImmune(ai?.ability as string ?? '', opp.ability as string, move.type)) return false;

			// Hazard moves: already at max layers on opponent's side
			if (move.id === 'stealthrock' && hazards.stealthRock) return false;
			if (move.id === 'spikes' && hazards.spikes >= 3) return false;
			if (move.id === 'toxicspikes' && hazards.toxicSpikes >= 2) return false;
			if (move.id === 'stickyweb' && hazards.stickyWeb) return false;

			// Status infliction: target already has a status condition
			if (move.status && oppHasStatus) return false;

			// Trap moves: target already trapped
			if (TRAP_IDS.has(move.id) && oppIsTrapped) return false;

			// Protect: consecutive use always fails
			if (PROTECT_IDS.has(move.id) && lastWasProtect) return false;

			// Self-buffs are useless when dying: the AI won't survive to use the boost.
			// Permanent debuffs on the opponent (burn, par, psn) and hazards are still
			// worth using because they persist after the AI faints — those pass through.
			if ((dyingThisTurn || likelyDyingSoon) && move.target === 'self') {
				const boosts = (move as AnyObject).boosts as AnyObject | undefined;
				if (boosts && Object.values(boosts).some((v: number) => v > 0)) return false;
			}

			// Protect when dying this turn just hands the opponent a free turn.
			if (dyingThisTurn && PROTECT_IDS.has(move.id)) return false;

			return true;
		});

		return filtered.length > 0 ? filtered : candidates;
	}

	/** Opponent's available actions: all non-disabled moves + abstract switch option. */
	private getOpponentOptions(opp: Pokemon): Action[] {
		const actions: Action[] = [];
		for (let i = 0; i < opp.moveSlots.length; i++) {
			const slot = opp.moveSlots[i];
			if (slot.disabled) continue;
			const move = this.battle.dex.moves.get(slot.id);
			actions.push({ kind: 'move', slot: i + 1, move });
		}
		const oppBench = this.battle.sides[0].pokemon.slice(1).filter(p => p && !p.fainted && p.hp > 0);
		if (oppBench.length > 0) {
			const aiActive = this.battle.sides[1].active[0];
			let bestBench = oppBench[0];
			if (aiActive) {
				let bestScore = -Infinity;
				for (const p of oppBench) {
					let offScore = 0;
					for (const slot of p.moveSlots) {
						const m = this.battle.dex.moves.get(slot.id);
						if (m.basePower > 0 && this.battle.dex.getImmunity(m.type, aiActive.types) &&
								!isAbilityImmune(p.ability as string, aiActive.ability as string, m.type)) {
							const eff = Math.pow(2, this.battle.dex.getEffectiveness(m.type, aiActive.types));
							if (eff > offScore) offScore = eff;
						}
					}
					if (offScore > bestScore) { bestScore = offScore; bestBench = p; }
				}
			}
			actions.push({ kind: 'switch', slot: 0, pokemon: bestBench });
		}
		return actions.length > 0
			? actions
			: [{ kind: 'move', slot: 1, move: this.battle.dex.moves.get(opp.moveSlots[0]?.id ?? 'tackle') }];
	}

	/** Highest-damage move the attacker has against defender (for switch modeling). */
	private getBestMoveAgainst(attacker: Pokemon, defender: Pokemon): Move {
		let bestMove: Move | null = null;
		let bestDmg = -1;
		for (const slot of attacker.moveSlots) {
			const m = this.battle.dex.moves.get(slot.id);
			if (m.basePower === 0) continue;
			if (!this.battle.dex.getImmunity(m.type, defender.types)) continue;
			if (isAbilityImmune(attacker.ability as string, defender.ability as string, m.type)) continue;
			const { damage } = this.simulateDamage(m, attacker, defender);
			if (damage > bestDmg) { bestDmg = damage; bestMove = m; }
		}
		return bestMove ?? this.battle.dex.moves.get(attacker.moveSlots[0]?.id ?? 'tackle');
	}
}
