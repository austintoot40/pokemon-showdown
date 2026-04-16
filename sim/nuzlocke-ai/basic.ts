/**
 * Nuzlocke AI — Basic
 *
 * Plays like a standard NPC trainer. All behavior is inherited from the base class
 * defaults, which implement basic scoring throughout.
 */

import type { Battle } from '../battle';
import { NuzlockeAI } from './base';

export class BasicAI extends NuzlockeAI {
	constructor(battle: Battle) {
		super(battle);
	}
}
