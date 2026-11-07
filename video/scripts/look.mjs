// Read-only: open a URL headless and print its inputs, buttons and a text sample (no logins, no writes).
import { launch, sleep } from "./cdp.mjs";
const url = process.argv[2];
const b = await launch({ width: 1600, height: 900 });
await b.goto(url, Number(process.argv[3] || 6000));
console.log(JSON.stringify(await b.js(`({
  url: location.href, title: document.title,
  inputs: [...document.querySelectorAll('input,textarea')].map(e => ({ id: e.id, name: e.name, type: e.type, ph: e.placeholder })),
  buttons: [...document.querySelectorAll('button, a[role=button], input[type=submit]')].map(e => (e.id ? '#' + e.id + ' ' : '') + (e.textContent || e.value || '').trim().slice(0, 40)).filter(Boolean).slice(0, 25),
  text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500)
})`), null, 1));
if (process.argv[4]) await b.shot(process.argv[4]);
b.close();
