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

import * as fs from 'fs';
import * as path from 'path';
import type { Battle } from '../battle';
import type { RolloutState } from './rollout';
import {
	rolloutPolicy, stepRollout, isRolloutTerminal, evaluateRolloutState,
} from './rollout';

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_PATH = path.join(process.cwd(), 'logs', 'competitive-ai.log');

function appendLog(text: string): void {
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		fs.appendFileSync(LOG_PATH, text);
	} catch {
		// Never crash the game over logging
	}
}

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
			this.logSingleMove(initialState, candidateMoveIndices[0]);
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

		this.logDecision(initialState, arms, best.moveIdx);
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

	private logDecision(state: RolloutState, arms: Arm[], bestMoveIdx: number): void {
		const lines: string[] = [];
		const turn = this.battle.turn;
		const aiMon = state.ai[state.aiActiveIdx];
		const oppMon = state.opp[state.oppActiveIdx];

		// Battle separator on turn 1
		if (turn <= 1) {
			lines.push('\n' + '='.repeat(60) + ' NEW BATTLE ' + '='.repeat(60) + '\n');
		}

		lines.push(`\n=== Turn ${turn} — MCTS Decision ===\n`);

		// Active Pokemon
		const pct = (m: typeof aiMon) => `${(m.hp / m.maxHp * 100).toFixed(1)}%`;
		const sts = (s: string) => s || 'none';
		lines.push(`AI  active: ${aiMon.ref.species.name.padEnd(12)} ${pct(aiMon).padStart(6)}  | status: ${sts(aiMon.status)}\n`);
		lines.push(`Opp active: ${oppMon.ref.species.name.padEnd(12)} ${pct(oppMon).padStart(6)}  | status: ${sts(oppMon.status)}\n`);

		// Hazards
		const fmtHazards = (h: typeof state.hazardsOnAiSide) => {
			const parts: string[] = [];
			if (h.stealthRock) parts.push('SR');
			if (h.spikes > 0) parts.push(`Spikes×${h.spikes}`);
			if (h.toxicSpikes > 0) parts.push(`TSpikes×${h.toxicSpikes}`);
			if (h.stickyWeb) parts.push('Web');
			return parts.length > 0 ? parts.join(', ') : 'none';
		};
		lines.push(`Hazards — opp side: ${fmtHazards(state.hazardsOnOppSide)}  |  ai side: ${fmtHazards(state.hazardsOnAiSide)}\n`);

		// Bench
		const fmtBench = (team: typeof state.ai, activeIdx: number) =>
			team
				.filter((m, i) => i !== activeIdx && !m.fainted)
				.map(m => `${m.ref.species.name} ${pct(m)}`)
				.join(', ') || '(empty)';
		lines.push(`AI  bench: ${fmtBench(state.ai, state.aiActiveIdx)}\n`);
		lines.push(`Opp bench: ${fmtBench(state.opp, state.oppActiveIdx)}\n`);

		// MCTS results
		const totalRollouts = arms.reduce((s, a) => s + a.visits, 0);
		lines.push(`\nMCTS: ${this.timeBudgetMs}ms budget, ${totalRollouts} rollouts, depth ${this.rolloutDepth}\n`);
		lines.push(`${'Move'.padEnd(20)} ${'Visits'.padStart(7)}  ${'Avg Score'.padStart(10)}\n`);
		lines.push(`${'-'.repeat(44)}\n`);

		const sorted = [...arms].sort((a, b) => {
			const avgA = a.visits > 0 ? a.totalNormScore / a.visits : -Infinity;
			const avgB = b.visits > 0 ? b.totalNormScore / b.visits : -Infinity;
			return avgB - avgA;
		});

		for (const arm of sorted) {
			const moveName = this.battle.dex.moves.get(
				aiMon.ref.moveSlots[arm.moveIdx]?.id ?? ''
			).name || `slot${arm.moveIdx + 1}`;
			const rawAvg = arm.visits > 0
				? ((arm.totalNormScore / arm.visits) * SCORE_RANGE + SCORE_MIN).toFixed(1)
				: 'N/A';
			const chosen = arm.moveIdx === bestMoveIdx ? '  ← CHOSEN' : '';
			lines.push(
				`${moveName.padEnd(20)} ${arm.visits.toString().padStart(7)}  ${rawAvg.padStart(10)}${chosen}\n`
			);
		}
		lines.push('---\n');

		appendLog(lines.join(''));
	}

	private logSingleMove(state: RolloutState, moveIdx: number): void {
		const moveName = this.battle.dex.moves.get(
			state.ai[state.aiActiveIdx].ref.moveSlots[moveIdx]?.id ?? ''
		).name || `slot${moveIdx + 1}`;
		appendLog(`\n=== Turn ${this.battle.turn} — only candidate: ${moveName} ===\n`);
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
