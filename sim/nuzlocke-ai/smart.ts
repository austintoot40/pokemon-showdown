/**
 * Nuzlocke AI — Smart
 *
 * Intermediate AI with type-matchup awareness, kill-shot prioritization,
 * recovery logic, and tactical switching when hard-countered.
 */

import type { Battle } from '../battle';
import type { Pokemon } from '../pokemon';
import type { ChoiceRequest } from '../side';
import { NuzlockeAI, type DmgCtx, type MoveCtx } from './base';

export class SmartAI extends NuzlockeAI {
	constructor(battle: Battle) {
		super(battle);
	}

	// =========================================================================
	// Voluntary switching — Based on Run and Bun spec
	// =========================================================================

	protected override considerVoluntarySwitch(request: ChoiceRequest): string | null {
		// @ts-expect-error jank request parser
		if (request.active?.[0]?.trapped) return null;
		const aiActive = this.battle.sides[1].active[0];
		const opponent = this.battle.sides[0].active[0];
		if (!aiActive || !opponent) return null;

		// Switch if all offensive moves are immune or fully resisted by opponent
		const usableMoves = aiActive.moveSlots.filter(slot => {
			if (slot.disabled) return false;
			const move = this.battle.dex.moves.get(slot.id);
			if (move.basePower === 0) return true;
			if (!this.battle.dex.getImmunity(move.type, opponent)) return false;
			return this.battle.dex.getEffectiveness(move.type, opponent) >= 0;
		});

		// Switch if opponent has a 2× move vs AI and AI is below 60% HP
		const hardCountered = opponent.moveSlots.some(slot => {
			const move = this.battle.dex.moves.get(slot.id);
			return move.basePower > 0 &&
				this.battle.dex.getImmunity(move.type, aiActive) &&
				this.battle.dex.getEffectiveness(move.type, aiActive) >= 1;
		});

		const shouldSwitch = usableMoves.length === 0 || (hardCountered && aiActive.hp / aiActive.maxhp < 0.6);
		if (!shouldSwitch) return null;

		// No safety filter — picks the best available option without checking survivability
		const candidates = this.battle.sides[1].pokemon.slice(1).filter(p => p && !p.fainted && p.hp > 0);
		if (candidates.length === 0) return null;

		const currentScore = this.scoreSwitchTarget(aiActive, opponent);
		const bestBenchScore = Math.max(...candidates.map(p => this.scoreSwitchTarget(p, opponent)));
		if (bestBenchScore <= currentScore) return null;

		let bestSlot = -1;
		let bestScore = -Infinity;
		for (const p of candidates) {
			const score = this.scoreSwitchTarget(p, opponent);
			if (score > bestScore) {
				bestScore = score;
				const idx = this.battle.sides[1].pokemon.indexOf(p);
				if (idx > 0) bestSlot = idx + 1;
			}
		}
		return bestSlot !== -1 ? `switch ${bestSlot}` : null;
	}

	// =========================================================================
	// Recovery
	// =========================================================================

	protected override shouldRecover(attacker: Pokemon, defender: Pokemon, healFraction: number): boolean {
		return attacker.hp / attacker.maxhp < 0.5;
	}

	// =========================================================================
	// Damage move feature hooks
	// =========================================================================

	protected override highestDamageBonus(): number {
		return Math.random() < 0.8 ? 6 : 8;
	}

	protected override killBonus(dmgCtx: DmgCtx): number {
		return dmgCtx.kills ? (dmgCtx.faster ? 6 : 3) : 0;
	}

	protected override acidSprayBonus(): number {
		return 6;
	}

	protected override pursuitBonus(ctx: MoveCtx): number {
		if (ctx.move.id !== 'pursuit') return 0;
		let bonus = 0;
		if (ctx.dmgCtx!.kills) {
			bonus += 10;
		} else {
			const oppHpFrac = ctx.defender.hp / ctx.defender.maxhp;
			if (oppHpFrac < 0.2) bonus += 10;
			else if (oppHpFrac < 0.4 && Math.random() < 0.5) bonus += 8;
		}
		if (ctx.dmgCtx!.faster) bonus += 3;
		return bonus;
	}

	protected override scoreContraryMove(ctx: MoveCtx): number | null {
		const { attacker, defender, dmgCtx, faster } = ctx;
		if (attacker.ability !== 'contrary' as ID) return null;
		if (ctx.isHighestDamage || dmgCtx!.kills) return null;
		const selfBoosts = (ctx.move as AnyObject).self?.boosts;
		if (!selfBoosts) return null;
		const spaBoost = -(selfBoosts.spa ?? 0);
		const atkBoost = -(selfBoosts.atk ?? 0);
		if (spaBoost >= 2) {
			let score = 6;
			if (this.isIncapacitated(defender)) {
				score += 3;
			} else {
				const can3HKO = this.maxOpponentDamage(defender, attacker) * 3 >= attacker.hp;
				if (!can3HKO) {
					score += 1;
					if (faster) score += 1;
				}
			}
			if ((attacker.boosts.spa ?? 0) >= 2) score -= 1;
			return score;
		} else if (atkBoost >= 1) {
			let score = 6;
			const can2HKO = this.maxOpponentDamage(defender, attacker) * 2 >= attacker.hp;
			if (this.isIncapacitated(defender)) score += 3;
			else if (can2HKO && !faster) score -= 5;
			return score;
		}
		return null;
	}

	protected override scoreStatReductionMove(ctx: MoveCtx): number {
		const { move, defender, faster } = ctx;
		const sec = (move as AnyObject).secondary;
		const blocked = defender.ability === 'contrary' as ID ||
			defender.ability === 'clearbody' as ID ||
			defender.ability === 'whitesmoke' as ID;
		const hasSpeDown = sec?.chance === 100 && (sec?.boosts?.spe ?? 0) < 0;
		if (hasSpeDown) {
			return (!blocked && !faster) ? 6 : 5;
		}
		const hasAtkDown = sec?.chance === 100 && (sec?.boosts?.atk ?? 0) < 0;
		const hasSpaDown = sec?.chance === 100 && (sec?.boosts?.spa ?? 0) < 0;
		if (hasAtkDown || hasSpaDown) {
			const relevantCategory: 'Physical' | 'Special' = hasAtkDown ? 'Physical' : 'Special';
			const targetHasSplit = this.hasMoveCategory(defender, relevantCategory);
			return (!blocked && targetHasSplit) ? 6 : 5;
		}
		return 0;
	}

	// =========================================================================
	// Fell Stinger
	// =========================================================================

	protected override scoreFellStinger(ctx: MoveCtx): number {
		const dmgCtx = ctx.dmgCtx!;
		if (dmgCtx.kills && (ctx.attacker.boosts.atk ?? 0) < 6) {
			return dmgCtx.faster
				? (Math.random() < 0.8 ? 21 : 23)
				: (Math.random() < 0.8 ? 15 : 17);
		}
		return this.scoreDamagingMove(ctx);
	}

	// =========================================================================
	// Status move hooks
	// =========================================================================

	protected override scoreStealthRock(ctx: MoveCtx): number {
		if (this.battle.sides[0].sideConditions['stealthrock']) return -20;
		return ctx.attacker.activeTurns <= 1 ? 7 : 6;
	}

	protected override scoreSpikes(ctx: MoveCtx): number {
		const spikes = this.battle.sides[0].sideConditions['spikes'];
		if (spikes && ((spikes as AnyObject).layers ?? 1) >= 3) return -20;
		const alreadySet = spikes ? 1 : 0;
		const firstTurn = ctx.attacker.activeTurns <= 1;
		return (firstTurn ? 7 : 6) - alreadySet;
	}

	protected override scoreToxicSpikes(ctx: MoveCtx): number {
		const tspikes = this.battle.sides[0].sideConditions['toxicspikes'];
		if (tspikes && ((tspikes as AnyObject).layers ?? 1) >= 2) return -20;
		const alreadySet = tspikes ? 1 : 0;
		const firstTurn = ctx.attacker.activeTurns <= 1;
		return (firstTurn ? 7 : 6) - alreadySet;
	}

	protected override scoreParalysis(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Electric')) return -20;
		const oppSpe = this.getBoostedStat(ctx.defender, 'spe');
		const aiSpe = this.getBoostedStat(ctx.attacker, 'spe');
		const playerFasterButSlowedByPar = oppSpe > aiSpe && Math.floor(oppSpe / 4) < aiSpe;
		const aiHasFlinchMove = ctx.attacker.moveSlots.some(slot => {
			const m = this.battle.dex.moves.get(slot.id);
			return (m as AnyObject).secondary?.volatileStatus === 'flinch';
		});
		const playerHasVolatile = !!(ctx.defender.volatiles['confusion'] || ctx.defender.volatiles['attract']);
		let score = (playerFasterButSlowedByPar || aiHasFlinchMove || playerHasVolatile) ? 8 : 7;
		if (Math.random() < 0.5) score -= 1;
		return score;
	}

	protected override scoreBurn(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Fire')) return -20;
		return this.hasMoveCategory(ctx.defender, 'Physical') ? 6 : 5;
	}

	protected override scoreSleep(ctx: MoveCtx): number {
		if (ctx.defender.status) return -20;
		if (ctx.defender.volatiles['yawn']) return -20;
		return 7;
	}

	protected override scoreProtect(ctx: MoveCtx): number {
		const lastId = ctx.attacker.lastMove?.id ?? '';
		const protectIds = ['protect', 'kingsshield', 'spikyshield', 'banefulbunker'];
		if (protectIds.includes(lastId)) return -20;
		return 6;
	}

	protected override scoreSubstitute(ctx: MoveCtx): number {
		if (ctx.hpFrac <= 0.5) return -20;
		if (ctx.defender.ability === 'infiltrator' as ID) return -20;
		return 6;
	}

	protected override scoreEncore(ctx: MoveCtx): number {
		if (!ctx.defender.lastMove) return -20;
		if (ctx.defender.volatiles['encore']) return -20;
		const lastMoveWasStatus = this.battle.dex.moves.get(ctx.defender.lastMove.id).category === 'Status';
		if (lastMoveWasStatus) return ctx.faster ? 7 : (Math.random() < 0.5 ? 6 : 5);
		return Math.random() < 0.5 ? 6 : 5;
	}

	protected override scoreExplodeSelf(ctx: MoveCtx): number {
		return ctx.hpFrac < 0.2 ? 7 : 5;
	}

	protected override scoreStickyWeb(ctx: MoveCtx): number {
		if (this.battle.sides[0].sideConditions['stickyweb']) return -20;
		return ctx.attacker.activeTurns <= 1 ? 9 : 6;
	}

	protected override scoreTailwind(ctx: MoveCtx): number {
		return !ctx.faster ? 9 : 5;
	}

	protected override scoreTrickRoom(ctx: MoveCtx): number {
		if (this.battle.field.pseudoWeather['trickroom']) return -20;
		return !ctx.faster ? 10 : 5;
	}

	protected override scoreReflectLightScreen(ctx: MoveCtx): number {
		const correspondingCategory: 'Physical' | 'Special' = ctx.move.id === 'reflect' ? 'Physical' : 'Special';
		let score = 6;
		if (this.hasMoveCategory(ctx.defender, correspondingCategory)) {
			if (ctx.attacker.item === 'lightclay' as ID) score += 1;
			if (Math.random() < 0.5) score += 1;
		}
		return score;
	}

	protected override scoreFinalGambit(ctx: MoveCtx): number {
		if (ctx.faster && ctx.attacker.hp > ctx.defender.hp) return 8;
		const dies = this.maxOpponentDamage(ctx.defender, ctx.attacker) >= ctx.attacker.hp;
		if (ctx.faster && dies) return 7;
		return 6;
	}

	protected override scoreFocusEnergy(ctx: MoveCtx): number {
		if (ctx.defender.ability === 'shellarmor' as ID || ctx.defender.ability === 'battlearmor' as ID) return -20;
		const hasHighCrit = (
			ctx.attacker.ability === 'superluck' as ID ||
			ctx.attacker.ability === 'sniper' as ID ||
			ctx.attacker.item === 'scopelens' as ID ||
			ctx.attacker.item === 'razorclaw' as ID ||
			ctx.attacker.moveSlots.some(s => ((this.battle.dex.moves.get(s.id) as AnyObject).critRatio ?? 1) >= 2)
		);
		return hasHighCrit ? 7 : 6;
	}

	protected override scoreCounterMirrorCoat(ctx: MoveCtx): number {
		const { attacker, defender, faster } = ctx;
		const relevantCategory: 'Physical' | 'Special' = ctx.move.id === 'counter' ? 'Physical' : 'Special';
		const canOHKO = this.maxOpponentDamage(defender, attacker) >= attacker.hp;
		const hasSturdy = attacker.ability === 'sturdy' as ID;
		const hasSash = attacker.item === 'focussash' as ID;
		if (canOHKO && !hasSturdy && !hasSash) return -14;
		let score = 6;
		const targetOnlyHasRelevantSplit = (
			this.hasMoveCategory(defender, relevantCategory) &&
			!this.hasMoveCategory(defender, relevantCategory === 'Physical' ? 'Special' : 'Physical')
		);
		if (canOHKO && (hasSturdy || hasSash) && attacker.hp === attacker.maxhp && targetOnlyHasRelevantSplit) {
			score += 2;
		} else if (!canOHKO && targetOnlyHasRelevantSplit) {
			if (Math.random() < 0.8) score += 2;
		}
		if (faster && Math.random() < 0.25) score -= 1;
		if (defender.moveSlots.some(s => this.battle.dex.moves.get(s.id).category === 'Status') && Math.random() < 0.25) score -= 1;
		return score;
	}

	protected override scoreSetupMove(ctx: MoveCtx): number {
		const { attacker, defender, faster } = ctx;
		const boosts = (ctx.move as AnyObject).boosts as AnyObject;
		const offBoost = (boosts.atk ?? 0) + (boosts.spa ?? 0);
		const defBoost = (boosts.def ?? 0) + (boosts.spd ?? 0);
		const speBoost = boosts.spe ?? 0;

		if (speBoost > 0 && offBoost === 0 && defBoost === 0) return faster ? -20 : 7;

		const canOHKO = this.maxOpponentDamage(defender, attacker) >= attacker.hp;

		if (ctx.move.id === 'shellsmash') {
			if ((attacker.boosts.atk ?? 0) >= 1) return -20;
			return canOHKO ? -20 : 6;
		}

		if (ctx.move.id === 'bellydrum') {
			if (this.isIncapacitated(defender)) return 9;
			const hasSitrus = attacker.item === 'sitrusberry' as ID;
			const hpAfterDrum = hasSitrus ? attacker.maxhp * 0.75 : attacker.hp * 0.5;
			if (this.maxOpponentDamage(defender, attacker) >= hpAfterDrum) return 4;
			return 8;
		}

		return canOHKO ? -20 : 6;
	}
}
