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
	// When a battle is active the URL hash points to the battle room, so
	// view-nuzlocke is never opened by the client on reconnect. Force-navigate
	// so the nuzlocke panel exists before the deferred state push arrives.
	if (game?.inBattle) navigateToNuzlocke(user.id);
	// If view-nuzlocke was opened before login (e.g. on page reload via URL hash),
	// it received a null/dashboard state. Push the real state now so it updates.
	setImmediate(() => pushNuzlockeState(user.id, game));
};

export { nuzlockePages as pages } from './pages';
export { nuzlockeCommands as commands } from './commands';
export { battleHandlers as handlers } from './battle';
