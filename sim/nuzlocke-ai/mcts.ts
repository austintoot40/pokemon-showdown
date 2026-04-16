/**
 * Nuzlocke AI — MCTS Engine
 *
 * UCB1 multi-armed bandit over the AI's candidate moves.
 * One arm per root AI move; each arm accumulates rollout scores.
 *
 * Why not a full tree? The branching factor (moves × opp_moves)^depth is
 * enormous. The real value of MCTS here is rollout depth, not tree depth —
 * we want to see multi-turn payoffs (hazards, status, setup) not enumerate
 * states. A flat bandit gives us that with minimal overhead.
 *
 * Scores are normalized to [0, 1] for UCB1 so the exploration constant
 * remains meaningful regardless of the raw score range (≈ −1000 to +1000).
 */

import type { Battle } from '../battle';
import type { RolloutState } from './rollout';
import {
	rolloutPolicy, stepRollout, isRolloutTerminal, evaluateRolloutState,
} from './rollout';

const SCORE_MIN = -1000;
const SCORE_MAX = 1000;
const SCORE_RANGE = SCORE_MAX - SCORE_MIN;

function normalize(score: number): number {
	return (Math.max(SCORE_MIN, Math.min(SCORE_MAX, score)) - SCORE_MIN) / SCORE_RANGE;
}

interface Arm {
	moveIdx: number;
	visits: number;
	totalNormScore: number; // sum of normalized scores
}

export class MCTSEngine {
	constructor(
		private battle: Battle,
		private timeBudgetMs = 200,
		private rolloutDepth = 8
	) {}

	/**
	 * Run MCTS and return the 0-based move index with the highest average score.
	 * `candidateMoveIndices` are 0-based indices into the active Pokémon's moveSlots.
	 */
	selectMove(initialState: RolloutState, candidateMoveIndices: number[]): number {
		if (candidateMoveIndices.length === 1) {
			return candidateMoveIndices[0];
		}

		const arms: Arm[] = candidateMoveIndices.map(moveIdx => ({
			moveIdx,
			visits: 0,
			totalNormScore: 0,
		}));

		const deadline = Date.now() + this.timeBudgetMs;

		while (Date.now() < deadline) {
			const arm = this.selectArm(arms);
			const score = this.runRollout(initialState, arm.moveIdx);
			arm.visits++;
			arm.totalNormScore += normalize(score);
		}

		// Pick arm with highest average score (ignore unvisited arms — shouldn't happen)
		let best = arms[0];
		for (const arm of arms) {
			if (arm.visits === 0) continue;
			if (best.visits === 0) { best = arm; continue; }
			if (arm.totalNormScore / arm.visits > best.totalNormScore / best.visits) {
				best = arm;
			}
		}

		return best.moveIdx;
	}

	private selectArm(arms: Arm[]): Arm {
		const totalVisits = arms.reduce((s, a) => s + a.visits, 0);
		const C = Math.SQRT2;

		let bestArm = arms[0];
		let bestUcb = -Infinity;

		for (const arm of arms) {
			// Always visit unvisited arms before exploiting
			if (arm.visits === 0) return arm;
			const avg = arm.totalNormScore / arm.visits;
			const ucb = avg + C * Math.sqrt(Math.log(totalVisits) / arm.visits);
			if (ucb > bestUcb) { bestUcb = ucb; bestArm = arm; }
		}

		return bestArm;
	}

	private runRollout(initialState: RolloutState, aiMoveIdx: number): number {
		// Turn 0: apply the root AI move with a sampled opponent response
		const oppMoveIdx = rolloutPolicy(this.battle, initialState, 'opp');
		let state = stepRollout(this.battle, initialState, aiMoveIdx, oppMoveIdx);

		// Turns 1..depth-1: both sides play rollout policy
		for (let depth = 1; depth < this.rolloutDepth; depth++) {
			if (isRolloutTerminal(state)) break;
			const ai = rolloutPolicy(this.battle, state, 'ai');
			const opp = rolloutPolicy(this.battle, state, 'opp');
			state = stepRollout(this.battle, state, ai, opp);
		}

		return evaluateRolloutState(this.battle, state);
	}
}
