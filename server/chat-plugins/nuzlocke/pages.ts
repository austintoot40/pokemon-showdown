/**
 * Nuzlocke Simulator — Page handler
 *
 * After the Phase 8 client refactor, this file contains only the bare page
 * handler. It pushes the current game state as JSON so the Preact panel in
 * panel-nuzlocke.tsx can render it. All HTML rendering has been removed.
 */

'use strict';

import { nuzlockeGames, pushNuzlockeState, closeNuzlockePanel } from './game';
import { createNuzlockeBattle, goToTeambuilding } from './battle';

export const nuzlockePages: Chat.PageTable = {
	nuzlocke(query, user) {
		const game = nuzlockeGames.get(user.id);
		// Deferred so it runs after setHTML sends |init|html — otherwise the room
		// doesn't exist client-side yet when the message arrives and is dropped.
		if (game) {
			if (game.curRoom === 'battle' && !game.inBattle) {
				// Chained battle: user clicked Continue on the previous battle.
				// Start the next battle in the chain now.
				const userId = user.id;
				setImmediate(() => {
					const u = Users.get(userId);
					if (u) createNuzlockeBattle(game, u);
					else goToTeambuilding(game);
				});
			} else {
				setImmediate(() => pushNuzlockeState(user.id, game));
			}
		} else {
			setImmediate(() => closeNuzlockePanel(user.id));
		}
		return '';
	},
};
