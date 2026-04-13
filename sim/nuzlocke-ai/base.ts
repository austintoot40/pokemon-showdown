/**
 * Nuzlocke AI — Base Class
 *
 * Defines the full decision-making interface. Game-accurate behavior is the default
 * for all overridable methods. Subclasses (SmartAI, CompetitiveAI) override only the
 * methods where their difficulty diverges.
 */

import type { Battle } from '../battle';
import type { Pokemon } from '../pokemon';
import type { ChoiceRequest } from '../side';

export interface DmgCtx {
	damage: number;
	kills: boolean;
	faster: boolean;
}

export interface MoveCtx {
	move: Move;
	attacker: Pokemon;
	defender: Pokemon;
	dmgCtx: DmgCtx | null;
	isHighestDamage: boolean;
	/** For damage moves: aiFaster || move.priority > 0. For status moves: speed comparison only. */
	faster: boolean;
	hpFrac: number;
}

export abstract class NuzlockeAI {
	constructor(protected battle: Battle) {}

	// =========================================================================
	// Entry point
	// =========================================================================

	decide(request: ChoiceRequest): string | false {
		if (request.wait) return false;
		if (request.forceSwitch) return this.forceSwitch(request);
		// @ts-expect-error jank request parser
		if (request.active?.[0]) {
			const voluntarySwitch = this.considerVoluntarySwitch(request);
			if (voluntarySwitch) return voluntarySwitch;
			return this.chooseMove(request);
		}
		return 'default';
	}

	// =========================================================================
	// Infrastructure (concrete — no difficulty branching)
	// =========================================================================

	protected forceSwitch(request: ChoiceRequest): string {
		const aiSide = this.battle.sides[1];
		const opponent = this.battle.sides[0].active[0];
		if (!opponent) {
			return `switch ${this.battle.random(2, request.side.pokemon.length + 1)}`;
		}
		let bestSlot = -1;
		let bestScore = -Infinity;
		for (let i = 1; i < aiSide.pokemon.length; i++) {
			const p = aiSide.pokemon[i];
			if (!p || p.fainted || p.hp <= 0) continue;
			const score = this.scoreSwitchTarget(p, opponent);
			if (score > bestScore) {
				bestScore = score;
				bestSlot = i + 1;
			}
		}
		if (bestSlot === -1) {
			for (let i = 1; i < aiSide.pokemon.length; i++) {
				const p = aiSide.pokemon[i];
				if (p && !p.fainted && p.hp > 0) return `switch ${i + 1}`;
			}
			return `switch 2`;
		}
		return `switch ${bestSlot}`;
	}

	protected chooseMove(request: ChoiceRequest): string {
		const aiActive = this.battle.sides[1].active[0];
		const opponent = this.battle.sides[0].active[0];
		if (!aiActive || !opponent) {
			// @ts-expect-error jank request parser
			return `move ${this.battle.random(1, request.active[0].moves.length + 1)}`;
		}
		// @ts-expect-error jank request parser
		const moves = request.active[0].moves as Array<{id: string, disabled: boolean | string}>;

		const aiSpeed = this.getBoostedStat(aiActive, 'spe');
		const oppSpeed = this.getBoostedStat(opponent, 'spe');
		const aiFaster = aiSpeed > oppSpeed;

		const dmgCtxMap = new Map<number, DmgCtx>();
		let highestDamage = 0;
		let anyKills = false;

		for (let i = 0; i < moves.length; i++) {
			if (moves[i].disabled) continue;
			const move = this.battle.dex.moves.get(moves[i].id);
			if (move.basePower === 0) continue;
			if (!this.battle.dex.getImmunity(move.type, opponent)) continue;
			const faster = aiFaster || move.priority > 0;
			const { damage } = this.simulateDamage(move, aiActive, opponent);
			const kills = damage >= opponent.hp;
			const excludedFromHighest = (
				!!(move as AnyObject).flags?.trap ||
				move.id === 'rollout' || move.id === 'iceball' ||
				move.id === 'futuresight' || move.id === 'doomdesire' ||
				move.id === 'meteorbeam' || move.id === 'relicsong'
			);
			dmgCtxMap.set(i, { damage, kills, faster, excludedFromHighest } as any);
			if (!excludedFromHighest) {
				if (damage > highestDamage) highestDamage = damage;
				if (kills) anyKills = true;
			}
		}

		let bestSlot = 1;
		let bestScore = -Infinity;
		let tiedCount = 0;
		for (let i = 0; i < moves.length; i++) {
			if (moves[i].disabled) continue;
			const dmgCtx = dmgCtxMap.get(i) as (DmgCtx & { excludedFromHighest: boolean }) | undefined ?? null;
			const isHighestDamage = dmgCtx !== null && !(dmgCtx as any).excludedFromHighest &&
				(anyKills ? dmgCtx.kills : dmgCtx.damage >= highestDamage);
			const score = this.scoreMove(moves[i].id, this.battle.dex.moves.get(moves[i].id), aiActive, opponent, dmgCtx, isHighestDamage);
			if (score > bestScore) {
				bestScore = score;
				bestSlot = i + 1;
				tiedCount = 1;
			} else if (score === bestScore) {
				tiedCount++;
				if (Math.floor(Math.random() * tiedCount) === 0) bestSlot = i + 1;
			}
		}
		return `move ${bestSlot}`;
	}

	protected scoreSwitchTarget(benched: Pokemon, opponent: Pokemon): number {
		let offensiveScore = 0;
		for (const slot of benched.moveSlots) {
			const move = this.battle.dex.moves.get(slot.id);
			if (move.basePower > 0 && this.battle.dex.getImmunity(move.type, opponent)) {
				const eff = Math.pow(2, this.battle.dex.getEffectiveness(move.type, opponent));
				if (eff > offensiveScore) offensiveScore = eff;
			}
		}
		let defensivePenalty = 0;
		for (const slot of opponent.moveSlots) {
			const move = this.battle.dex.moves.get(slot.id);
			if (move.basePower > 0 && this.battle.dex.getImmunity(move.type, benched)) {
				const eff = Math.pow(2, this.battle.dex.getEffectiveness(move.type, benched));
				if (eff > defensivePenalty) defensivePenalty = eff;
			}
		}
		let hazardHpLost = 0;
		if (this.battle.sides[1].sideConditions['stealthrock']) {
			const rockEff = Math.pow(2, this.battle.dex.getEffectiveness('Rock', benched));
			hazardHpLost += benched.maxhp * rockEff / 8;
		}
		if (this.battle.sides[1].sideConditions['spikes']) {
			const layers = (this.battle.sides[1].sideConditions['spikes'] as any).layers ?? 1;
			const spikeFraction = [0, 1 / 8, 1 / 6, 1 / 4][Math.min(layers, 3)];
			const isGrounded = !benched.types.includes('Flying') && benched.ability !== 'levitate' as ID;
			if (isGrounded) hazardHpLost += benched.maxhp * spikeFraction;
		}
		const switchInDamage = this.maxOpponentDamage(opponent, benched);
		const effectiveHp = Math.max(0, benched.hp - hazardHpLost - switchInDamage);
		return offensiveScore - defensivePenalty + effectiveHp / benched.maxhp;
	}

	protected simulateDamage(move: Move, attacker: Pokemon, defender: Pokemon): { damage: number } {
		if (move.basePower === 0 || !this.battle.dex.getImmunity(move.type, defender)) return { damage: 0 };
		const effExp = this.battle.dex.getEffectiveness(move.type, defender);
		const effectiveness = Math.pow(2, effExp);
		const stab = attacker.types.includes(move.type) ? 1.5 : 1.0;
		const isPhysical = move.category === 'Physical';
		const atkStat = this.getBoostedStat(attacker, isPhysical ? 'atk' : 'spa');
		const defStat = this.getBoostedStat(defender, isPhysical ? 'def' : 'spd');
		const roll = 0.85 + Math.random() * 0.15;
		return { damage: move.basePower * effectiveness * stab * (atkStat / defStat) * roll };
	}

	protected maxOpponentDamage(attacker: Pokemon, defender: Pokemon): number {
		let maxDamage = 0;
		for (const slot of attacker.moveSlots) {
			const m = this.battle.dex.moves.get(slot.id);
			if (m.basePower === 0 || !this.battle.dex.getImmunity(m.type, defender)) continue;
			const { damage } = this.simulateDamage(m, attacker, defender);
			if (damage > maxDamage) maxDamage = damage;
		}
		return maxDamage;
	}

	protected getBoostedStat(pokemon: Pokemon, stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe'): number {
		const base = pokemon.storedStats[stat];
		const boost = pokemon.boosts[stat];
		const mult = boost >= 0 ? (2 + boost) / 2 : 2 / (2 - boost);
		return Math.floor(base * mult);
	}

	protected hasMoveCategory(pokemon: Pokemon, category: 'Physical' | 'Special'): boolean {
		return pokemon.moveSlots.some(slot => {
			const move = this.battle.dex.moves.get(slot.id);
			return move.category === category && move.basePower > 0;
		});
	}

	protected isIncapacitated(pokemon: Pokemon): boolean {
		return pokemon.status === 'slp' || pokemon.status === 'frz';
	}

	// =========================================================================
	// Decision point: voluntary switching
	// Game-accurate default: never switch voluntarily.
	// =========================================================================

	protected considerVoluntarySwitch(request: ChoiceRequest): string | null {
		return null;
	}

	// =========================================================================
	// Decision point: recovery
	// Game-accurate default: never use recovery.
	// =========================================================================

	protected shouldRecover(attacker: Pokemon, defender: Pokemon, healFraction: number): boolean {
		return false;
	}

	// =========================================================================
	// Move scoring dispatcher (concrete)
	// Handles universal guards and dispatches to per-move hook methods.
	// =========================================================================

	protected scoreMove(
		moveId: string,
		move: Move,
		attacker: Pokemon,
		defender: Pokemon,
		dmgCtx: DmgCtx | null,
		isHighestDamage: boolean
	): number {
		if (move.basePower > 0) {
			if (!this.battle.dex.getImmunity(move.type, defender)) return -20;
			if (dmgCtx === null) return -20;

			const ctx: MoveCtx = {
				move, attacker, defender, dmgCtx, isHighestDamage,
				faster: dmgCtx.faster,
				hpFrac: attacker.hp / attacker.maxhp,
			};

			if (moveId === 'rollout' || moveId === 'iceball') return 7;
			if ((move as AnyObject).flags?.trap) return this.scoreTrap(ctx);
			if (moveId === 'futuresight' || moveId === 'doomdesire') return this.scoreFutureSight(ctx);
			if (moveId === 'relicsong') return this.scoreRelicSong(ctx);
			if (moveId === 'meteorbeam') return this.scoreMeteorBeam(ctx);
			if (moveId === 'fellstinger') return this.scoreFellStinger(ctx);
			if (moveId === 'suckerpunch') return this.scoreSuckerPunch(ctx);
			if (moveId === 'fakeout') return this.scoreFakeOut(ctx);
			return this.scoreDamagingMove(ctx);
		}

		// Status move
		const faster = this.getBoostedStat(attacker, 'spe') > this.getBoostedStat(defender, 'spe');
		const ctx: MoveCtx = {
			move, attacker, defender, dmgCtx: null, isHighestDamage: false,
			faster, hpFrac: attacker.hp / attacker.maxhp,
		};
		return this.scoreStatusMove(ctx);
	}

	// =========================================================================
	// Damage move hooks
	// =========================================================================

	/** Trapping moves (Bind, Wrap, etc.) */
	protected scoreTrap(ctx: MoveCtx): number {
		return this.highestDamageBonus();
	}

	/** Future Sight / Doom Desire */
	protected scoreFutureSight(ctx: MoveCtx): number {
		const dies = this.maxOpponentDamage(ctx.defender, ctx.attacker) >= ctx.attacker.hp;
		let score = (ctx.dmgCtx!.faster && dies) ? 8 : 6;
		score += this.killBonus(ctx.dmgCtx!);
		return score;
	}

	/** Relic Song (Meloetta) */
	protected scoreRelicSong(ctx: MoveCtx): number {
		if (ctx.attacker.species.id === 'meloettapirouette' as ID) return -20;
		let score = 10;
		score += this.killBonus(ctx.dmgCtx!);
		return score;
	}

	/** Meteor Beam — only useful with Power Herb */
	protected scoreMeteorBeam(ctx: MoveCtx): number {
		if (ctx.attacker.item !== 'powerherb' as ID) return -20;
		let score = 9;
		score += this.killBonus(ctx.dmgCtx!);
		return score;
	}

	/** Fell Stinger — game-accurate: treat as normal damage */
	protected scoreFellStinger(ctx: MoveCtx): number {
		return this.scoreDamagingMove(ctx);
	}

	/** Sucker Punch — anti-spam guard */
	protected scoreSuckerPunch(ctx: MoveCtx): number {
		if (ctx.attacker.lastMove?.id === 'suckerpunch' && Math.random() < 0.5) return -20;
		return this.scoreDamagingMove(ctx);
	}

	/** Fake Out — turn-1 bonus, fall through on later turns */
	protected scoreFakeOut(ctx: MoveCtx): number {
		if (
			ctx.attacker.activeTurns <= 1 &&
			ctx.defender.ability !== 'shielddust' as ID &&
			ctx.defender.ability !== 'innerfocus' as ID
		) {
			return 9 + this.killBonus(ctx.dmgCtx!);
		}
		return this.scoreDamagingMove(ctx);
	}

	/**
	 * General damaging move scoring.
	 * Game-accurate default: isHighestDamage ? highestDamageBonus : 0.
	 * No kill bonus, no priority bonus, no stat-reduction utility.
	 */
	protected scoreDamagingMove(ctx: MoveCtx): number {
		let score = ctx.isHighestDamage ? this.highestDamageBonus() : 0;
		score += this.killBonus(ctx.dmgCtx!);
		score += this.priorityBonus(ctx);
		if (ctx.move.id === 'acidspray') score += this.acidSprayBonus();
		score += this.pursuitBonus(ctx);
		const contraryScore = this.scoreContraryMove(ctx);
		if (contraryScore !== null) return contraryScore;
		if (!ctx.isHighestDamage && score === 0) score = this.scoreStatReductionMove(ctx);
		return score;
	}

	// =========================================================================
	// Per-feature damage move hooks (game-accurate defaults = no bonus)
	// =========================================================================

	/** +6 for game-accurate, randomized for smart/competitive. */
	protected highestDamageBonus(): number { return 6; }

	/** Kill bonus added to killing moves. Game-accurate: 0. */
	protected killBonus(dmgCtx: DmgCtx): number { return 0; }

	/** Priority move bonus when dying and slower. Game-accurate / smart: 0. */
	protected priorityBonus(ctx: MoveCtx): number { return 0; }

	/** Acid Spray utility bonus. Game-accurate: 0. */
	protected acidSprayBonus(): number { return 0; }

	/** Pursuit stacking bonus. Game-accurate: 0. */
	protected pursuitBonus(ctx: MoveCtx): number { return 0; }

	/**
	 * Contrary ability scoring. Returns a score to use (early exit) or null to continue.
	 * Game-accurate: null (no special handling).
	 */
	protected scoreContraryMove(ctx: MoveCtx): number | null { return null; }

	/**
	 * Score non-highest-damage moves that have speed/stat reduction secondaries.
	 * Game-accurate: 0 (no utility scoring).
	 */
	protected scoreStatReductionMove(ctx: MoveCtx): number { return 0; }

	// =========================================================================
	// Status move dispatcher
	// =========================================================================

	protected scoreStatusMove(ctx: MoveCtx): number {
		const { move, attacker, defender } = ctx;
		const moveId = move.id;

		// Universal: don't re-apply an existing status
		if (move.status && defender.status) return -20;

		if (moveId === 'stealthrock') return this.scoreStealthRock(ctx);
		if (moveId === 'spikes') return this.scoreSpikes(ctx);
		if (moveId === 'toxicspikes') return this.scoreToxicSpikes(ctx);

		if (move.status === 'par') return this.scoreParalysis(ctx);
		if (move.status === 'brn') return this.scoreBurn(ctx);
		if (move.status === 'psn' || move.status === 'tox') return this.scorePoison(ctx);
		if (move.status === 'slp' || moveId === 'yawn') return this.scoreSleep(ctx);

		if (moveId === 'morningsun' || moveId === 'synthesis' || moveId === 'moonlight') {
			return this.scoreSunRecovery(ctx);
		}
		if (move.heal?.[0] && (move.heal[0] as number) > 0) return this.scoreRecovery(ctx);
		if (moveId === 'rest') return this.scoreRest(ctx);

		if (moveId === 'protect' || moveId === 'kingsshield' || moveId === 'spikyshield' || moveId === 'banefulbunker') {
			return this.scoreProtect(ctx);
		}
		if (moveId === 'substitute') return this.scoreSubstitute(ctx);

		if (moveId === 'agility' || moveId === 'rockpolish' || moveId === 'autotomize') {
			return ctx.faster ? -20 : 7;
		}

		if (moveId === 'taunt') return this.scoreTaunt(ctx);
		if (moveId === 'encore') return this.scoreEncore(ctx);
		if (moveId === 'explosion' || moveId === 'selfdestruct' || moveId === 'mistyexplosion') {
			return this.scoreExplodeSelf(ctx);
		}
		if (moveId === 'batonpass') return this.scoreBatonPass(ctx);
		if (moveId === 'destinybond') return this.scoreDestinyBond(ctx);
		if (moveId === 'trick' || moveId === 'switcheroo') return this.scoreTrick(ctx);
		if (moveId === 'imprison') return this.scoreImprison(ctx);
		if (moveId === 'stickyweb') return this.scoreStickyWeb(ctx);
		if (moveId === 'tailwind') return this.scoreTailwind(ctx);
		if (moveId === 'trickroom') return this.scoreTrickRoom(ctx);
		if (moveId === 'reflect' || moveId === 'lightscreen') return this.scoreReflectLightScreen(ctx);
		if (moveId === 'finalgambit') return this.scoreFinalGambit(ctx);
		if (moveId === 'memento') return this.scoreMemento(ctx);
		if (moveId === 'focusenergy' || moveId === 'laserfocus') return this.scoreFocusEnergy(ctx);
		if (['electricterrain', 'psychicterrain', 'grassyterrain', 'mistyterrain'].includes(moveId)) {
			return this.scoreTerrain(ctx);
		}
		if (moveId === 'counter' || moveId === 'mirrorcoat') return this.scoreCounterMirrorCoat(ctx);

		if (move.boosts) return this.scoreSetupMove(ctx);

		return 6;
	}

	// =========================================================================
	// Status move hooks (game-accurate defaults)
	// =========================================================================

	protected scoreStealthRock(ctx: MoveCtx): number {
		if (this.battle.sides[0].sideConditions['stealthrock']) return -20;
		return 6;
	}

	protected scoreSpikes(ctx: MoveCtx): number {
		const spikes = this.battle.sides[0].sideConditions['spikes'];
		if (spikes && ((spikes as AnyObject).layers ?? 1) >= 3) return -20;
		return 6;
	}

	protected scoreToxicSpikes(ctx: MoveCtx): number {
		const tspikes = this.battle.sides[0].sideConditions['toxicspikes'];
		if (tspikes && ((tspikes as AnyObject).layers ?? 1) >= 2) return -20;
		return 6;
	}

	protected scoreParalysis(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Electric')) return -20;
		// Paralysis logic is the same for smart and competitive (non-game-accurate):
		// game-accurate simply returns 6.
		return 6;
	}

	protected scoreBurn(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Fire')) return -20;
		return 6;
	}

	protected scorePoison(ctx: MoveCtx): number {
		if (ctx.defender.types.includes('Steel') || ctx.defender.types.includes('Poison')) return -20;
		return 6;
	}

	protected scoreSleep(ctx: MoveCtx): number {
		if (ctx.defender.status) return -20;
		if (ctx.defender.volatiles['yawn']) return -20;
		return 6;
	}

	protected scoreSunRecovery(ctx: MoveCtx): number {
		if (ctx.hpFrac >= 1.0) return -20;
		if (ctx.hpFrac >= 0.85) return -6;
		if (this.battle.field.isWeather(['sunnyday', 'desolateland'])) {
			if (this.shouldRecover(ctx.attacker, ctx.defender, 2 / 3)) return 7;
		}
		return this.shouldRecover(ctx.attacker, ctx.defender, 0.5) ? 7 : 5;
	}

	protected scoreRecovery(ctx: MoveCtx): number {
		if (ctx.hpFrac >= 1.0) return -20;
		if (ctx.hpFrac >= 0.85) return -6;
		const healNumerator = (ctx.move.heal?.[0] as number) ?? 1;
		const healDenominator = (ctx.move.heal?.[1] as number) ?? 2;
		return this.shouldRecover(ctx.attacker, ctx.defender, healNumerator / healDenominator) ? 7 : 5;
	}

	protected scoreRest(ctx: MoveCtx): number {
		if (ctx.hpFrac >= 1.0) return -20;
		if (ctx.hpFrac >= 0.85) return -6;
		return this.shouldRecover(ctx.attacker, ctx.defender, 1.0) ? 7 : 5;
	}

	protected scoreProtect(ctx: MoveCtx): number {
		return 5;
	}

	protected scoreSubstitute(ctx: MoveCtx): number {
		if (ctx.hpFrac <= 0.5) return -20;
		if (ctx.defender.ability === 'infiltrator' as ID) return -20;
		return 5;
	}

	protected scoreTaunt(ctx: MoveCtx): number {
		const opponentHasStatus = ctx.defender.moveSlots.some(
			s => this.battle.dex.moves.get(s.id).category === 'Status'
		);
		return opponentHasStatus ? 6 : 5;
	}

	protected scoreEncore(ctx: MoveCtx): number {
		if (!ctx.defender.lastMove) return -20;
		if (ctx.defender.volatiles['encore']) return -20;
		return 5;
	}

	protected scoreExplodeSelf(ctx: MoveCtx): number {
		return -20;
	}

	protected scoreBatonPass(ctx: MoveCtx): number {
		return 5;
	}

	protected scoreDestinyBond(ctx: MoveCtx): number {
		return 5;
	}

	protected scoreTrick(ctx: MoveCtx): number {
		return 5;
	}

	protected scoreImprison(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreStickyWeb(ctx: MoveCtx): number {
		if (this.battle.sides[0].sideConditions['stickyweb']) return -20;
		return 6;
	}

	protected scoreTailwind(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreTrickRoom(ctx: MoveCtx): number {
		if (this.battle.field.pseudoWeather['trickroom']) return -20;
		return 6;
	}

	protected scoreReflectLightScreen(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreFinalGambit(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreMemento(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreFocusEnergy(ctx: MoveCtx): number {
		if (ctx.defender.ability === 'shellarmor' as ID || ctx.defender.ability === 'battlearmor' as ID) return -20;
		return 6;
	}

	protected scoreTerrain(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreCounterMirrorCoat(ctx: MoveCtx): number {
		return 6;
	}

	protected scoreSetupMove(ctx: MoveCtx): number {
		const { attacker, defender, faster } = ctx;
		const boosts = (ctx.move as AnyObject).boosts as AnyObject;
		const offBoost = (boosts.atk ?? 0) + (boosts.spa ?? 0);
		const defBoost = (boosts.def ?? 0) + (boosts.spd ?? 0);
		const speBoost = boosts.spe ?? 0;
		// Pure speed boost — same for all difficulties
		if (speBoost > 0 && offBoost === 0 && defBoost === 0) return faster ? -20 : 7;
		return 6;
	}
}
