/**
 * Nuzlocke AI — Smart
 *
 * Best possible heuristics-based AI. Includes type-matchup awareness,
 * kill-shot prioritization, principled recovery logic, strategic switching,
 * and full context-sensitive status/setup move scoring.
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
	// Voluntary switching — unified scoring path
	//
	// Returns a scored switch candidate that competes directly against the best
	// move score in decide(). Score is on the same integer scale as move scores
	// (~6 = regular move, ~9–12 = kill shot).
	//
	// Key properties:
	//  - Only considers bench Pokemon that can absorb the switch-in hit.
	//  - Score scales with how much better the bench matchup is vs staying in.
	//  - Penalised by the current Pokemon's positive boost total so a set-up
	//    Pokemon won't casually abandon its boosts for a marginal improvement.
	//  - Hard cap of 10 so switching never outbids a kill shot (which scores 9–14).
	// =========================================================================

	protected override chooseBestSwitch(request: ChoiceRequest): { slot: number; score: number } | null {
		// @ts-expect-error jank request parser
		if (request.active?.[0]?.trapped) return null;
		const aiActive = this.battle.sides[1].active[0];
		const opponent = this.battle.sides[0].active[0];
		if (!aiActive || !opponent) return null;

		const oppSpd = this.getEffectiveSpeed(opponent);
		const aiBench = this.battle.sides[1].pokemon.slice(1).filter(p => p && !p.fainted && p.hp > 0);

		// Safety filter: only switch into a Pokemon that can absorb the switch-in hit
		const candidates = aiBench.filter(p => {
			const benchSpd = this.getEffectiveSpeed(p);
			const incomingDmg = this.maxOpponentDamage(opponent, p);
			if (benchSpd > oppSpd && incomingDmg < p.hp) return true;
			if (benchSpd <= oppSpd && incomingDmg * 2 < p.hp) return true;
			return false;
		});
		if (candidates.length === 0) return null;

		const currentScore = this.scoreSwitchTarget(aiActive, opponent);

		let bestSlot = -1;
		let bestBenchScore = -Infinity;
		for (const p of candidates) {
			const score = this.scoreSwitchTarget(p, opponent);
			if (score > bestBenchScore) {
				bestBenchScore = score;
				const idx = this.battle.sides[1].pokemon.indexOf(p);
				if (idx > 0) bestSlot = idx + 1;
			}
		}
		if (bestSlot === -1) return null;

		const delta = bestBenchScore - currentScore;
		if (delta <= 0) return null;

		// Reduce switch appeal proportional to positive boosts being abandoned
		const boostTotal = Object.values(aiActive.boosts)
			.reduce((sum, v) => sum + Math.max(0, v as number), 0);

		// delta=1 → ~6 (ties with a normal damaging move)
		// delta=2 → ~8 (beats normal moves, loses to kill shots)
		// delta=3+ → capped at 10 (loses to faster kill shots scoring 12+)
		const rawScore = 4 + delta * 2 - boostTotal * 1.5;
		if (rawScore <= 0) return null;

		return { slot: bestSlot, score: Math.min(rawScore, 10) };
	}

	// =========================================================================
	// Recovery — full principled logic
	// =========================================================================

	protected override shouldRecover(attacker: Pokemon, defender: Pokemon, healFraction: number): boolean {
		const hpFrac = attacker.hp / attacker.maxhp;
		if (attacker.status === 'tox') return false;
		const healAmount = attacker.maxhp * healFraction;
		const maxDamage = this.maxOpponentDamage(defender, attacker);
		if (maxDamage >= healAmount) return false;
		const faster = this.getBoostedStat(attacker, 'spe') > this.getBoostedStat(defender, 'spe');
		if (faster) {
			if (maxDamage >= attacker.hp && attacker.hp + healAmount > maxDamage) return true;
			if (hpFrac < 0.4) return true;
			if (hpFrac < 0.66) return Math.random() < 0.5;
			return false;
		} else {
			if (hpFrac < 0.5) return true;
			if (hpFrac < 0.7) return Math.random() < 0.75;
			return false;
		}
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

	protected override priorityBonus(ctx: MoveCtx): number {
		if (ctx.move.priority > 0 && !ctx.faster) {
			if (this.maxOpponentDamage(ctx.defender, ctx.attacker) >= ctx.attacker.hp) return 11;
		}
		return 0;
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
	// Two-turn moves
	// =========================================================================

	private static readonly INVULNERABLE_CHARGE = new Set([
		'fly', 'bounce', 'dig', 'dive', 'phantomforce', 'shadowforce', 'skydrop',
	]);

	private canSkipCharge(move: Move, attacker: Pokemon): boolean {
		const weather = this.battle.field.weather as string;
		if (move.id === 'solarbeam' || move.id === 'solarblade') {
			return weather === 'sunnyday' || weather === 'desolateland';
		}
		if (move.id === 'electroshot') {
			return weather === 'raindance' || weather === 'primordialsea';
		}
		if (attacker.item === 'powerherb' as ID) return true;
		return false;
	}

	/**
	 * Attack-then-recharge moves (Hyper Beam, Giga Impact, Blast Burn, etc.).
	 * If the move kills, no recharge turn is spent against a live opponent — full credit.
	 * If it doesn't kill, we're gifting the opponent a free turn: heavily penalize.
	 */
	protected override scoreRechargeMove(ctx: MoveCtx): number {
		const { dmgCtx } = ctx;
		if (dmgCtx!.kills) {
			return this.highestDamageBonus() + this.killBonus(dmgCtx!);
		}
		return 2;
	}

	/**
	 * Charge-then-attack moves (Solar Beam, Sky Attack, Fly, Bounce, Dig, etc.).
	 * - Weather/Power Herb skip: treat as a full-power one-turn move.
	 * - Invulnerable (Fly/Bounce/Dig/Dive/Phantom Force/Shadow Force): safe during charge,
	 *   but still effectively half-power over two turns unless killing.
	 * - Grounded charge (Solar Beam without sun, Skull Bash, etc.): opponent can hit us;
	 *   reject if incoming damage would KO during the charge turn.
	 */
	protected override scoreChargingMove(ctx: MoveCtx): number {
		const { move, attacker, defender, dmgCtx } = ctx;

		if (this.canSkipCharge(move, attacker)) {
			// Full single-turn move — give competitive score since isHighestDamage is excluded
			if (dmgCtx!.kills) return 12;
			return 7;
		}

		const isInvulnerable = SmartAI.INVULNERABLE_CHARGE.has(move.id);
		if (!isInvulnerable) {
			const incomingDmg = this.maxOpponentDamage(defender, attacker);
			if (incomingDmg >= attacker.hp) return -20; // die during charge turn
			if (incomingDmg * 2 >= attacker.hp) return 1; // heavy damage during charge
		}

		if (dmgCtx!.kills) return 5 + this.killBonus(dmgCtx!);
		return isInvulnerable ? 4 : 2;
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

	protected override scoreLeechSeed(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Grass')) return -20;

		const aiDmg = this.maxOpponentDamage(ctx.attacker, ctx.defender);
		const oppDmg = this.maxOpponentDamage(ctx.defender, ctx.attacker);

		// Opponent OHKOs — leech never fires
		if (oppDmg >= ctx.attacker.hp) return -20;

		// We can 2HKO — attacking is strictly better than waiting for leech chip
		if (aiDmg * 2 >= ctx.defender.hp) return 3;

		// Opponent 2HKOs — leech has marginal value, probably not enough turns to matter
		if (oppDmg * 2 >= ctx.attacker.hp) return 4;

		// Long fight expected — leech seed is strong here
		let score = 7;
		if (ctx.faster) score += 1;  // drain ticks same turn we use it relative to opponent's EOT
		return score;
	}

	protected override scoreStealthRock(ctx: MoveCtx): number {
		if (this.battle.sides[0].sideConditions['stealthrock']) return -20;
		const firstTurn = ctx.attacker.activeTurns <= 1;
		const base = Math.random() < 0.25 ? 8 : 9;
		return firstTurn ? base : base - 2;
	}

	protected override scoreSpikes(ctx: MoveCtx): number {
		const spikes = this.battle.sides[0].sideConditions['spikes'];
		if (spikes && ((spikes as AnyObject).layers ?? 1) >= 3) return -20;
		const alreadySet = spikes ? 1 : 0;
		const firstTurn = ctx.attacker.activeTurns <= 1;
		const base = Math.random() < 0.25 ? 8 : 9;
		return (firstTurn ? base : base - 2) - alreadySet;
	}

	protected override scoreToxicSpikes(ctx: MoveCtx): number {
		const tspikes = this.battle.sides[0].sideConditions['toxicspikes'];
		if (tspikes && ((tspikes as AnyObject).layers ?? 1) >= 2) return -20;
		const alreadySet = tspikes ? 1 : 0;
		const firstTurn = ctx.attacker.activeTurns <= 1;
		const base = Math.random() < 0.25 ? 8 : 9;
		return (firstTurn ? base : base - 2) - alreadySet;
	}

	protected override scoreParalysis(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Electric')) return -20;
		const oppEffSpd = this.getEffectiveSpeed(ctx.defender);
		const aiEffSpd = this.getEffectiveSpeed(ctx.attacker);
		const parFactor = this.battle.gen >= 7 ? 0.5 : 0.25;
		const playerFasterButSlowedByPar = oppEffSpd > aiEffSpd && Math.floor(oppEffSpd * parFactor) < aiEffSpd;
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
		let score = 6;
		if (Math.random() < 0.37) {
			if (this.hasMoveCategory(ctx.defender, 'Physical')) score += 1;
			if (ctx.attacker.moveSlots.some(s => s.id === 'hex')) score += 1;
		}
		return score;
	}

	protected override scorePoison(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Steel') || ctx.defender.types.includes('Poison')) return -20;
		let score = 6;
		if (Math.random() < 0.38) {
			const aiHasHex = ctx.attacker.moveSlots.some(s => s.id === 'hex');
			const aiHasVenoshock = ctx.attacker.moveSlots.some(s => s.id === 'venoshock');
			const aiHasMerciless = ctx.attacker.ability === 'merciless' as ID;
			const playerHasDmg = this.hasMoveCategory(ctx.defender, 'Physical') || this.hasMoveCategory(ctx.defender, 'Special');
			if ((aiHasHex || aiHasVenoshock || aiHasMerciless) && !playerHasDmg) score += 2;
		}
		return score;
	}

	protected override scoreSleep(ctx: MoveCtx): number {
		if (ctx.defender.status) return -20;
		if (ctx.defender.volatiles['yawn']) return -20;
		let score = 6;
		if (Math.random() < 0.25) {
			score += 1;
			const aiHasDreamEater = ctx.attacker.moveSlots.some(s => s.id === 'dreameater');
			const aiHasNightmare = ctx.attacker.moveSlots.some(s => s.id === 'nightmare');
			const playerHasSnore = ctx.defender.moveSlots.some(s => s.id === 'snore');
			const playerHasSleepTalk = ctx.defender.moveSlots.some(s => s.id === 'sleeptalk');
			if ((aiHasDreamEater || aiHasNightmare) && !playerHasSnore && !playerHasSleepTalk) score += 1;
			if (ctx.attacker.moveSlots.some(s => s.id === 'hex')) score += 1;
		}
		return score;
	}

	protected override scoreRest(ctx: MoveCtx): number {
		if (ctx.hpFrac >= 1.0) return -20;
		if (ctx.hpFrac >= 0.85) return -6;
		if (!this.shouldRecover(ctx.attacker, ctx.defender, 1.0)) return 5;
		const hasSleepCure = (
			ctx.attacker.item === 'lumberry' as ID ||
			ctx.attacker.item === 'chestoberry' as ID ||
			ctx.attacker.moveSlots.some(s => s.id === 'sleeptalk' || s.id === 'snore') ||
			ctx.attacker.ability === 'shedskin' as ID ||
			ctx.attacker.ability === 'earlybird' as ID ||
			(ctx.attacker.ability === 'hydration' as ID && this.battle.field.isWeather('raindance'))
		);
		return hasSleepCure ? 8 : 7;
	}

	protected override scoreProtect(ctx: MoveCtx): number {
		let score = 6;
		const aiDraining = ['psn', 'tox', 'brn'].includes(ctx.attacker.status || '') ||
			!!(ctx.attacker.volatiles['curse'] || ctx.attacker.volatiles['leechseed'] ||
			ctx.attacker.volatiles['attract'] || ctx.attacker.volatiles['perish2']);
		if (aiDraining) score -= 2;
		const playerDraining = ['psn', 'tox', 'brn'].includes(ctx.defender.status || '') ||
			!!(ctx.defender.volatiles['curse'] || ctx.defender.volatiles['leechseed']);
		if (playerDraining) score += 1;
		if (ctx.attacker.activeTurns <= 1) score -= 1;
		const lastId = ctx.attacker.lastMove?.id ?? '';
		const protectIds = ['protect', 'kingsshield', 'spikyshield', 'banefulbunker'];
		if (protectIds.includes(lastId)) {
			if (Math.random() < 0.5) return -20;
		}
		return score;
	}

	protected override scoreSubstitute(ctx: MoveCtx): number {
		if (ctx.hpFrac <= 0.5) return -20;
		if (ctx.defender.ability === 'infiltrator' as ID) return -20;

		const oppDmg = this.maxOpponentDamage(ctx.defender, ctx.attacker);
		const subHp = ctx.attacker.maxhp * 0.25;

		// Opponent breaks sub AND their follow-up KOs remaining HP — sub buys nothing
		if (oppDmg >= subHp && oppDmg >= ctx.attacker.hp - subHp) return 1;

		let score = 6;
		// Sub survives opponent's best move — free turns to attack or set up behind it
		if (oppDmg < subHp) score += 2;
		if (ctx.defender.status === 'slp') score += 2;
		if (ctx.defender.volatiles['leechseed'] && ctx.faster) score += 2;
		if (Math.random() < 0.5) score -= 1;
		const playerHasSoundMove = ctx.defender.moveSlots.some(slot =>
			(this.battle.dex.moves.get(slot.id) as AnyObject).flags?.sound
		);
		if (playerHasSoundMove) score -= 8;
		return score;
	}

	protected override scoreBlockMove(ctx: MoveCtx): number {
		const { attacker, defender } = ctx;
		const aiDmg = this.maxOpponentDamage(attacker, defender);
		const oppDmg = this.maxOpponentDamage(defender, attacker);

		// Opponent OHKOs us — Block just hands them a free turn
		if (oppDmg >= attacker.hp) return -20;

		// We OHKO — trap is excellent, forces opponent to lose their Pokemon
		if (aiDmg >= defender.hp) return 9;

		// Opponent 2HKOs us — we're losing this 1v1, use the turn for damage instead
		if (oppDmg * 2 >= attacker.hp) return 2;

		// We 2HKO and they don't — we're winning, trapping is useful
		if (aiDmg * 2 >= defender.hp) return 7;

		// Neither side 2HKOs — trap has some value (chip from switching is avoided)
		return 6;
	}

	protected override scoreTaunt(ctx: MoveCtx): number {
		if (ctx.defender.volatiles['taunt']) return -20;
		const trActive = !!this.battle.field.pseudoWeather['trickroom'];
		const opponentHasTR = ctx.defender.moveSlots.some(s => s.id === 'trickroom');
		if (opponentHasTR && !trActive) return 9;
		const opponentHasDefog = ctx.defender.moveSlots.some(s => s.id === 'defog');
		const auroraVeilUp = !!this.battle.sides[1].sideConditions['auroraveil'];
		if (opponentHasDefog && auroraVeilUp && ctx.faster) return 9;
		return 5;
	}

	protected override scoreEncore(ctx: MoveCtx): number {
		if (!ctx.defender.lastMove) return -20;
		if (ctx.defender.volatiles['encore']) return -20;
		const lastMoveWasStatus = this.battle.dex.moves.get(ctx.defender.lastMove.id).category === 'Status';
		if (lastMoveWasStatus) return ctx.faster ? 7 : (Math.random() < 0.5 ? 6 : 5);
		return Math.random() < 0.5 ? 6 : 5;
	}

	protected override scoreExplodeSelf(ctx: MoveCtx): number {
		const aiAlive = this.battle.sides[1].pokemon.filter(p => !p.fainted && p.hp > 0).length;
		const oppAlive = this.battle.sides[0].pokemon.filter(p => !p.fainted && p.hp > 0).length;
		if (aiAlive === 1 && oppAlive > 1) return -20;
		let score: number;
		if (ctx.hpFrac < 0.1) score = 10;
		else if (ctx.hpFrac < 0.33) score = Math.random() < 0.7 ? 8 : 0;
		else if (ctx.hpFrac < 0.66) score = Math.random() < 0.5 ? 7 : 0;
		else score = Math.random() < 0.05 ? 7 : 0;
		if (aiAlive === 1 && oppAlive === 1) score -= 1;
		return score;
	}

	protected override scoreBatonPass(ctx: MoveCtx): number {
		const bench = this.battle.sides[1].pokemon.slice(1).filter(p => p && !p.fainted && p.hp > 0);
		if (bench.length === 0) return -20;
		const hasSub = !!ctx.attacker.volatiles['substitute'];
		const hasBoost = Object.values(ctx.attacker.boosts).some(v => (v as number) > 0);
		if (hasSub || hasBoost) return 14;
		return 0;
	}

	protected override scoreDestinyBond(ctx: MoveCtx): number {
		const dies = this.maxOpponentDamage(ctx.defender, ctx.attacker) >= ctx.attacker.hp;
		if (ctx.faster && dies) return Math.random() < 0.81 ? 7 : 6;
		return Math.random() < 0.5 ? 5 : 6;
	}

	protected override scoreTrick(ctx: MoveCtx): number {
		const item = ctx.attacker.item;
		if (item === 'toxicorb' as ID || item === 'flameorb' as ID || item === 'blacksludge' as ID) {
			return Math.random() < 0.5 ? 6 : 7;
		}
		if (item === 'ironball' as ID || item === 'laggingtail' as ID || item === 'stickybarb' as ID) return 7;
		return 5;
	}

	protected override scoreImprison(ctx: MoveCtx): number {
		const hasSharedMove = ctx.defender.moveSlots.some(defSlot =>
			ctx.attacker.moveSlots.some(attSlot => attSlot.id === defSlot.id)
		);
		return hasSharedMove ? 9 : -20;
	}

	protected override scoreStickyWeb(ctx: MoveCtx): number {
		if (this.battle.sides[0].sideConditions['stickyweb']) return -20;
		const firstTurn = ctx.attacker.activeTurns <= 1;
		return firstTurn
			? (Math.random() < 0.25 ? 9 : 12)
			: (Math.random() < 0.25 ? 6 : 9);
	}

	protected override scoreTailwind(ctx: MoveCtx): number {
		if (this.battle.sides[1].sideConditions['tailwind']) return -20;
		return !ctx.faster ? 9 : 5;
	}

	protected override scoreTrickRoom(ctx: MoveCtx): number {
		if (this.battle.field.pseudoWeather['trickroom']) return -20;
		return !ctx.faster ? 10 : 5;
	}

	protected override scoreReflectLightScreen(ctx: MoveCtx): number {
		const condKey = (ctx.move as AnyObject).sideCondition as string | undefined
			?? (ctx.move.id === 'reflect' ? 'reflect' : 'lightscreen');
		if (this.battle.sides[1].sideConditions[condKey]) return -20;
		const correspondingCategory: 'Physical' | 'Special' = ctx.move.id === 'reflect' ? 'Physical' : 'Special';
		let score = 6;
		if (this.hasMoveCategory(ctx.defender, correspondingCategory)) {
			if (ctx.attacker.item === 'lightclay' as ID) score += 1;
			if (Math.random() < 0.5) score += 1;
		}
		return score;
	}

	protected override scoreAuroraVeil(ctx: MoveCtx): number {
		if (this.battle.sides[1].sideConditions['auroraveil']) return -20;
		if (!this.battle.field.isWeather(['hail', 'snow'])) return -20;
		let score = 7;
		if (ctx.attacker.item === 'lightclay' as ID) score += 1;
		return score;
	}

	protected override scoreWeather(ctx: MoveCtx): number {
		const moveWeather = (ctx.move as AnyObject).weather as string | undefined;
		if (moveWeather && this.battle.field.weather === moveWeather) return -20;
		// Sunny Day synergy: AI has Solar Beam/Blade → strong incentive to set up sun
		if (moveWeather === 'sunnyday') {
			const hasSolarMove = ctx.attacker.moveSlots.some(
				s => s.id === 'solarbeam' || s.id === 'solarblade'
			);
			if (hasSolarMove) return Math.random() < 0.5 ? 9 : 10;
		}
		return 7;
	}

	protected override scoreFinalGambit(ctx: MoveCtx): number {
		if (ctx.faster && ctx.attacker.hp > ctx.defender.hp) return 8;
		const dies = this.maxOpponentDamage(ctx.defender, ctx.attacker) >= ctx.attacker.hp;
		if (ctx.faster && dies) return 7;
		return 6;
	}

	protected override scoreMemento(ctx: MoveCtx): number {
		const bench = this.battle.sides[1].pokemon.slice(1).filter(p => !p.fainted && p.hp > 0);
		if (bench.length === 0) return -20;
		if (ctx.hpFrac < 0.1) return 16;
		if (ctx.hpFrac < 0.33) return Math.random() < 0.7 ? 14 : 6;
		if (ctx.hpFrac < 0.66) return Math.random() < 0.5 ? 13 : 6;
		return Math.random() < 0.05 ? 13 : 6;
	}

	protected override scoreFocusEnergy(ctx: MoveCtx): number {
		if (ctx.defender.ability === 'shellarmor' as ID || ctx.defender.ability === 'battlearmor' as ID) return -20;

		const oppDmg = this.maxOpponentDamage(ctx.defender, ctx.attacker);
		// Opponent OHKOs — we never get to use the crits
		if (oppDmg >= ctx.attacker.hp) return -20;
		// Opponent 2HKOs — we may only get one attack behind Focus Energy, not worth the setup turn
		if (oppDmg * 2 >= ctx.attacker.hp) return 3;

		const hasHighCrit = (
			ctx.attacker.ability === 'superluck' as ID ||
			ctx.attacker.ability === 'sniper' as ID ||
			ctx.attacker.item === 'scopelens' as ID ||
			ctx.attacker.item === 'razorclaw' as ID ||
			ctx.attacker.moveSlots.some(s => ((this.battle.dex.moves.get(s.id) as AnyObject).critRatio ?? 1) >= 2)
		);
		return hasHighCrit ? 7 : 6;
	}

	protected override scoreTerrain(ctx: MoveCtx): number {
		return ctx.attacker.item === 'terrainextender' as ID ? 9 : 8;
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
		const can2HKO = this.maxOpponentDamage(defender, attacker) * 2 >= attacker.hp;

		if (ctx.move.id === 'shellsmash') {
			if (canOHKO) return -20;
			if ((attacker.boosts.atk ?? 0) >= 1) return -20;
			let score = 6;
			if (this.isIncapacitated(defender)) score += 3;
			const hasWhiteHerb = attacker.item === 'whiteherb' as ID;
			const postSmashMult = hasWhiteHerb ? 1.0 : 1.5;
			const postSmashDamage = this.maxOpponentDamage(defender, attacker) * postSmashMult;
			score += postSmashDamage < attacker.hp ? 2 : -2;
			return score;
		}

		if (ctx.move.id === 'bellydrum') {
			if (this.isIncapacitated(defender)) return 9;
			const hasSitrus = attacker.item === 'sitrusberry' as ID;
			const hpAfterDrum = hasSitrus ? attacker.maxhp * 0.75 : attacker.hp * 0.5;
			if (this.maxOpponentDamage(defender, attacker) >= hpAfterDrum) return 4;
			return 8;
		}

		if (canOHKO) return -20;

		const defenderHasUnaware = defender.ability === 'unaware' as ID;
		const unawareExceptions = ['poweruppunch', 'swordsdance', 'howl'];
		if (defenderHasUnaware && !unawareExceptions.includes(ctx.move.id)) return -20;

		const isMixed = offBoost > 0 && defBoost > 0;
		let treatAsOffensive: boolean;
		if (isMixed) {
			if ((boosts.atk ?? 0) > 0 && (boosts.spa ?? 0) === 0) {
				treatAsOffensive = !(this.hasMoveCategory(defender, 'Physical') && !this.hasMoveCategory(defender, 'Special'));
			} else {
				treatAsOffensive = !(this.hasMoveCategory(defender, 'Special') && !this.hasMoveCategory(defender, 'Physical'));
			}
		} else {
			treatAsOffensive = offBoost > 0;
		}

		let score = 6;
		if (treatAsOffensive) {
			if (this.isIncapacitated(defender)) {
				score += 3;
			} else if (can2HKO && !faster) {
				score -= 5;
			}
			if (!isMixed && (boosts.spa ?? 0) > 0) {
				const can3HKO = this.maxOpponentDamage(defender, attacker) * 3 >= attacker.hp;
				if (!this.isIncapacitated(defender) && !can3HKO) {
					score += 1;
					if (faster) score += 1;
				}
				if ((attacker.boosts.spa ?? 0) >= 2) score -= 1;
			}
		} else {
			if (can2HKO && !faster) score -= 5;
			if (Math.random() < 0.95) {
				if (this.isIncapacitated(defender)) score += 2;
				if ((boosts.def ?? 0) > 0 && (boosts.spd ?? 0) > 0 &&
					((attacker.boosts.def ?? 0) < 2 || (attacker.boosts.spd ?? 0) < 2)) {
					score += 2;
				}
			}
		}
		return score;
	}
}
