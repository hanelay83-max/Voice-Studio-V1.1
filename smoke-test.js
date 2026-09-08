// Static smoke tests for the browser app.
// Run: node smoke-test.js
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('index.html','utf8');
const app = fs.readFileSync('app.js','utf8');
const css = fs.readFileSync('style.css','utf8');

function ok(name, cond){ if(!cond) throw new Error('FAIL: '+name); console.log('PASS:',name); }

ok('HTML has viewport meta', /name=["']viewport["'][^>]*width=device-width/i.test(html));
ok('HTML loads app.js', /src=["']app\.js["']/i.test(html));
ok('HTML has tool menu', /class=["']tool-menu["']/i.test(html));
ok('HTML has all five tools', ['tts','clone','transcript','history','settings'].every(x => new RegExp(`data-tool=["']${x}["']`).test(html)));
ok('HTML has transcript pane', /class=["']transcript-pane["']/.test(html));
ok('App is syntactically valid', !!new vm.Script(app));
ok('Responsive detector exists', /updateViewportProfile/.test(app) && /orientationchange/.test(app));
ok('Busy retry handling exists', /isBusyError/.test(app) && /1800/.test(app));
ok('Generation is sequential', /const concurrency = 1/.test(app));
ok('History is wired', /myvoice-history-v2/.test(app));
ok('CSS has phone breakpoint', /max-width:600px/.test(css));
ok('CSS has tablet breakpoint', /801px.*1099px/.test(css));
ok('CSS has desktop grid', /grid-template-columns:minmax\(320px,470px\)/.test(css));
console.log('\nAll static smoke tests passed.');
