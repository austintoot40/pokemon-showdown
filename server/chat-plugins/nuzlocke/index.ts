/**
 * Nuzlocke Simulator — Entry point
 */

'use strict';

import { loadNuzlockeData, nuzlockeGames, pushNuzlockeStatus, pushNuzlockeState, navigateToNuzlocke } from './game';

loadNuzlockeData();

export const loginfilter: Chat.LoginFilter = user => {
	if (!user.named) return;
	const game = nuzlockeGames.get(user.id) ?? null;
	pushNuzlockeStatus(user.id, game);
	if (game) {
		navigateToNuzlocke(user.id);
		setImmediate(() => pushNuzlockeState(user.id, game));
	}
};

export { nuzlockePages as pages } from './pages';
export { nuzlockeCommands as commands } from './commands';
export { battleHandlers as handlers } from './battle';
