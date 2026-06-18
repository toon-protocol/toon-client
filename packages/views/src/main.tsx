/** Browser bundle entry: mount the MCP-app runtime into #root. */
import './globals.css';
import { mount } from './app-entry.js';

const root = document.getElementById('root');
if (root) mount(root);
