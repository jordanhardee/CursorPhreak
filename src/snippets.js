'use strict';
// The "Copy Code" snippets. Both are fully self-contained: every frame is embedded as a PNG data URI,
// so nothing is ever fetched from another website.
//
// Browsers only show the first frame of an animated GIF/APNG used as a CSS cursor, and none of them can
// read .ani files, so animation has to be done by swapping still frames:
//   css: a @keyframes animation on the `cursor` property (works where only <style> is allowed)
//   js:  a tiny script that swaps the cursor on a timer, honouring each frame's own delay

const { pngFile } = require('./encoders');

function frameUrls(cur) {
  return cur.frames.map((f) => 'data:image/png;base64,' + pngFile(Buffer.from(f), cur.w, cur.h).toString('base64'));
}

function cssSnippet(cur) {
  const urls = frameUrls(cur);
  const at = (u) => `url(${u}) ${cur.hx} ${cur.hy},auto`;
  const tag = `<!-- CursorPhreak cursor #${cur.id} -->`;
  if (urls.length === 1) {
    return `<style type="text/css">html{cursor:${at(urls[0])}}html *{cursor:inherit!important}</style>${tag}`;
  }
  const total = cur.delays.reduce((a, b) => a + b, 0);
  let t = 0;
  const steps = urls.map((u, i) => {
    const pct = +((t / total) * 100).toFixed(3);
    t += cur.delays[i];
    return `${pct}%{cursor:${at(u)}}`;
  });
  steps.push(`100%{cursor:${at(urls[urls.length - 1])}}`);
  return (
    `<style type="text/css">@keyframes cphreak{${steps.join('')}}` +
    `html{cursor:${at(urls[0])};animation:cphreak ${total}ms step-end infinite}` +
    `html *{cursor:inherit!important}</style>${tag}`
  );
}

function jsSnippet(cur) {
  // Store each distinct image once; `q` is the frame order (cursors often loop back through frames).
  const urls = frameUrls(cur);
  const uniq = [...new Set(urls)];
  const order = urls.map((u) => uniq.indexOf(u));
  return (
    `<script>/* CursorPhreak cursor #${cur.id} */(function(){` +
    `var f=${JSON.stringify(uniq)},q=${JSON.stringify(order)},d=${JSON.stringify(cur.delays)},i=0,s=document.createElement("style");` +
    `(document.head||document.documentElement).appendChild(s);` +
    `function n(){s.textContent="html,html *{cursor:url("+f[q[i]]+") ${cur.hx} ${cur.hy},auto!important}";` +
    `if(q.length>1){setTimeout(n,d[i]);i=(i+1)%q.length}}n()})();</script>`
  );
}

function snippets(cur) {
  return { css: cssSnippet(cur), js: jsSnippet(cur) };
}

module.exports = { snippets, cssSnippet, jsSnippet };
