/**
 * Nuzlocke AI — Game Accurate
 *
 * Plays like a standard NPC trainer. All behavior is inherited from the base class
 * defaults, which implement game-accurate scoring throughout.
 */

import type { Battle } from '../battle';
import { NuzlockeAI } from './base';

export class GameAccurateAI extends NuzlockeAI {
	constructor(battle: Battle) {
		super(battle);
	}
}
