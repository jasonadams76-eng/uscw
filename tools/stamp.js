// Stamps a new version into the website so open browsers can tell a new release is out.
// Run this (node tools/stamp.js) before every commit that changes anything in docs/.
const fs = require('fs');
const path = require('path');
const docs = path.join(__dirname, '..', 'docs');
const d = new Date();
const p = n => String(n).padStart(2, '0');
const v = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;

fs.writeFileSync(path.join(docs, 'version.json'), JSON.stringify({ version: v }) + '\n');
fs.writeFileSync(path.join(docs, 'js', 'version.js'), `window.USCW_VERSION = '${v}';\n`);

const indexPath = path.join(docs, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(/(css\/style\.css|js\/(?:config|version|app)\.js)(\?v=[A-Za-z0-9._-]*)?(["'])/g, `$1?v=${v}$3`);
fs.writeFileSync(indexPath, html);
console.log('Stamped version ' + v);
