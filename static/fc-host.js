'use strict';

// funCentral's public address is funcentral.vocs.io. The old workers.dev host stays
// enabled (the Telegram webhook and older invite links point at it), so its pages
// forward there with the path, query and #ROOM intact. Page scripts check FC_MOVED
// and skip opening a room socket from the page that is on its way out.
window.FC_MOVED = location.hostname === 'sgbridgegame.vocs.workers.dev';
if (window.FC_MOVED) location.replace(`https://funcentral.vocs.io${location.pathname}${location.search}${location.hash}`);
