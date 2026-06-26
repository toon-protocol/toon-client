/** Browser bundle entry: mount the MCP-app runtime into #root. */
import './globals.css';
import { mount } from './app-entry.js';

// The MCP app renders inside the host's message container; keep the iframe page
// transparent so the host's own (rounded) surface shows through instead of an
// opaque slab. (globals.css paints `body` for the standalone gallery; the app
// overrides it here.)
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

const root = document.getElementById('root');
if (root) mount(root);
