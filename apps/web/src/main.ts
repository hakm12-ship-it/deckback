import './style.css';
import { startApp } from './app';
import { registerOffline } from './offline';

// The website. (The e2e's test page is its own entry, test.html, built only for the e2e: see test-page.ts.)
startApp();
registerOffline();
