'use strict';

/* Real-browser Coastline open/close regression. Frames are recorded from a
   throwaway Chrome profile; the test seeds only that profile's IndexedDB. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers/memory-world-cdp.js');

async function main() {
  const session = await H.launch({ width: 1280, height: 800 });
  const cdp = session.cdp;
  const shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-coast-transition-'));
  const frames = [];
  const samples = [];
  let passed = 0, failed = 0;
  const check = (name, ok, detail) => {
    if (ok) { passed++; console.log('PASS  ' + name); }
    else { failed++; console.error('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
  };
  cdp.on('Page.screencastFrame', params => {
    frames.push(params.data);
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  try {
    check('app.shell', await H.enterAppShell(cdp));
    check('memory.page', await H.goToMemoryPage(cdp));
    await H.seedMemories(cdp, H.makeRecords(5, 'coast-transition'));
    await H.evaluate(cdp, 'IB.memoryWorld.reload()');
    await H.sleep(1700); // Coastline read adapter has a short in-memory cache.
    await H.evaluate(cdp, "IB.memoryReferenceUI.setScene('sky'); IB.memoryReferenceUI.setScene('coast');");
    await H.settle(cdp);
    await H.waitFor(cdp, "!!document.querySelector('#mem-sky-coast .cs-go')", 5000);

    await cdp.send('Page.startScreencast', { format: 'png', quality: 100, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    await H.evaluate(cdp, "document.querySelector('#mem-sky-coast .cs-go').click()");
    const fullReady = await H.waitFor(cdp, "!!document.querySelector('#ib-coast.ready .cs-frame')", 20000);
    check('coast.fullFrameReady', fullReady);
    if (!fullReady) return finish();
    const frameVisible = await H.waitFor(cdp, "getComputedStyle(document.querySelector('#ib-coast .cs-frame')).opacity==='1'", 5000);
    check('coast.expandedFrameFinishesFadeIn', frameVisible);
    await H.sleep(150);
    const fullShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(shotsDir, 'coast-expanded.png'), Buffer.from(fullShot.data, 'base64'));

    const thumbResult = await H.evaluate(cdp, `(function(){
      var frame=document.querySelector('#ib-coast .cs-frame');
      var canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
      var ctx=canvas.getContext('2d'),gradient=ctx.createLinearGradient(0,0,64,36);
      gradient.addColorStop(0,'#163350');gradient.addColorStop(1,'#ead8b5');ctx.fillStyle=gradient;ctx.fillRect(0,0,64,36);
      ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(32,18,1.5,0,Math.PI*2);ctx.fill();
      var data=canvas.toDataURL('image/jpeg',0.92);
      window.dispatchEvent(new MessageEvent('message',{data:{ib:'coast-thumb',data:data,light:!document.body.classList.contains('theme-infernal')},source:frame.contentWindow}));
      return document.querySelector('#mem-sky-coast .cs-art').style.backgroundImage.indexOf('data:image/jpeg')>=0;
    })()`);
    check('exitUsesTheSameStaticCoastThumb', thumbResult === true);

    await H.evaluate(cdp, `(function(){
      window.__coastExitSamples=[];window.__coastExitSampleDone=false;
      function sample(){
        var overlay=document.getElementById('ib-coast');
        if(!overlay){window.__coastExitSampleDone=true;return}
        var bg=overlay.querySelector('.cs-bg'),frame=overlay.querySelector('.cs-frame');
        var style=bg&&getComputedStyle(bg);
        window.__coastExitSamples.push({
          repeat:style&&style.backgroundRepeat,size:style&&style.backgroundSize,
          image:style&&style.backgroundImage.slice(0,40),frameConnected:!!(frame&&frame.isConnected),
          frameOpacity:frame&&getComputedStyle(frame).opacity,ready:overlay.classList.contains('ready'),waitOpacity:getComputedStyle(overlay.querySelector('.cs-wait')).opacity,
          opacity:getComputedStyle(overlay).opacity,clip:getComputedStyle(overlay).clipPath
        });
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);document.querySelector('#ib-coast .cs-x').click();return true;
    })()`);
    await H.sleep(250);
    const exitMidShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(shotsDir, 'coast-exit-mid.png'), Buffer.from(exitMidShot.data, 'base64'));
    await H.sleep(250);
    const exitLateShot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(shotsDir, 'coast-exit-late.png'), Buffer.from(exitLateShot.data, 'base64'));

    const exitDone = await H.waitFor(cdp, 'window.__coastExitSampleDone===true', 5000);
    check('coast.exitTransitionCompletes', exitDone);
    const result = await H.evaluate(cdp, `JSON.stringify({samples:window.__coastExitSamples||[],full:IB.memoryReferenceUI.state().full,frames:${frames.length}})`);
    const data = JSON.parse(result || '{}');
    samples.push(...(data.samples || []));
    check('coast.backgroundNeverTilesDuringExit', samples.length > 2 && samples.every(s => s.repeat === 'no-repeat' && s.size === 'cover'),
      JSON.stringify(samples.slice(0, 3)));
    check('coast.readyFrameDoesNotResetToLoader', samples.length > 2 && samples.every(s => s.ready === true && Number(s.waitOpacity) === 0));
    check('coast.fullIframeSurvivesUntilAnimationEnds', samples.length > 2 && samples.every(s => s.frameConnected === true));
    check('coast.fullIframeRemainsVisibleThroughExit', samples.length > 2 && samples.every(s => Number(s.frameOpacity) >= 0.99));
    check('coast.fullIframeIsRemovedAfterExit', data.full === false && !await H.evaluate(cdp, "!!document.querySelector('#ib-coast .cs-frame')"));
    check('coast.realFramesRecorded', frames.length >= 6, 'frames=' + frames.length);

    await H.evaluate(cdp, "document.body.classList.add('theme-infernal')");
    await H.sleep(100);
    await H.evaluate(cdp, "document.querySelector('#mem-sky-coast .cs-go').click()");
    const darkReady = await H.waitFor(cdp, "!!document.querySelector('#ib-coast.ready .cs-frame')&&!document.getElementById('ib-coast').classList.contains('light')", 20000);
    check('coast.darkThemeFrameOpens', darkReady);
    if (darkReady) {
      check('coast.darkExpandedFrameFinishesFadeIn', await H.waitFor(cdp,"getComputedStyle(document.querySelector('#ib-coast .cs-frame')).opacity==='1'",5000));
      await H.sleep(150);
      const darkThumbSet = await H.evaluate(cdp, `(function(){
        var frame=document.querySelector('#ib-coast .cs-frame'),canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
        var ctx=canvas.getContext('2d'),g=ctx.createLinearGradient(0,0,64,36);g.addColorStop(0,'#163350');g.addColorStop(1,'#ead8b5');
        ctx.fillStyle=g;ctx.fillRect(0,0,64,36);ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(32,18,1.5,0,Math.PI*2);ctx.fill();
        var data=canvas.toDataURL('image/jpeg',0.92);
        window.dispatchEvent(new MessageEvent('message',{data:{ib:'coast-thumb',data:data,light:false},source:frame.contentWindow}));
        window.__coastDarkSamples=[];window.__coastDarkSampleDone=false;
        function sample(){var ov=document.getElementById('ib-coast');if(!ov){window.__coastDarkSampleDone=true;return}
          var bg=ov.querySelector('.cs-bg'),s=bg&&getComputedStyle(bg),f=ov.querySelector('.cs-frame');
          window.__coastDarkSamples.push({repeat:s&&s.backgroundRepeat,size:s&&s.backgroundSize,frame:!!(f&&f.isConnected),frameOpacity:f&&getComputedStyle(f).opacity,ready:ov.classList.contains('ready'),waitOpacity:getComputedStyle(ov.querySelector('.cs-wait')).opacity});requestAnimationFrame(sample)}
        requestAnimationFrame(sample);document.querySelector('#ib-coast .cs-x').click();return document.querySelector('#ib-coast').classList.contains('light')===false;
      })()`);
      check('coast.darkThemeUsesDarkFrame', darkThumbSet === true);
      const darkExitDone = await H.waitFor(cdp, 'window.__coastDarkSampleDone===true', 5000);
      const darkSamples = await H.evaluate(cdp, 'window.__coastDarkSamples||[]');
      check('coast.darkExitNeverTiles', darkExitDone && darkSamples.length > 2
        && darkSamples.every(sample => sample.repeat === 'no-repeat' && sample.size === 'cover'));
      check('coast.darkReadyFrameDoesNotResetToLoader', darkSamples.length > 2
        && darkSamples.every(sample => sample.ready === true && Number(sample.waitOpacity) === 0));
      check('coast.darkIframeLivesThroughExit', darkSamples.length > 2 && darkSamples.every(sample => sample.frame === true));
      check('coast.darkIframeRemainsVisibleThroughExit', darkSamples.length > 2 && darkSamples.every(sample => Number(sample.frameOpacity) >= 0.99));
    }

    if (frames.length) {
      const indexes = Array.from(new Set([0, Math.floor(frames.length / 2), frames.length - 1]));
      indexes.forEach((index, shot) => fs.writeFileSync(path.join(shotsDir, 'coast-' + shot + '.png'), Buffer.from(frames[index], 'base64')));
      console.log('Recorded browser frames: ' + frames.length + ' (sample PNGs in ' + shotsDir + ')');
    }
  } finally {
    try { await cdp.send('Page.stopScreencast'); } catch (_) {}
    await session.close();
    if (process.env.IB_COAST_FRAME_KEEP !== '1') {
      try { fs.rmSync(shotsDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
  console.log('\nCoastline transition: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;

  function finish() {
    console.log('\nCoastline transition: ' + passed + ' passed, ' + failed + ' failed');
    if (failed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
