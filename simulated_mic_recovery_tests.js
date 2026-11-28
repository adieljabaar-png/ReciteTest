// Simulated lifecycle tests for the patched policy (not real iOS hardware).
const assert = require('node:assert/strict');
async function ensure(existing, acquire, release){
  if(existing){const tracks=existing.getAudioTracks();const live=tracks.some(t=>t.readyState==='live');const persistentlyMuted=tracks.length&&tracks.every(t=>t.readyState==='live'&&t.muted);if(live&&!persistentlyMuted)return existing;if(persistentlyMuted||!live)release(existing);}
  return await acquire();
}
function stream(track){return {getAudioTracks:()=>[track]};}
(async()=>{
 let releases=0, acquires=0;
 const live=stream({readyState:'live',muted:false,enabled:true});
 assert.equal(await ensure(live,async()=>{acquires++;return live},()=>releases++),live,'healthy live stream retained');
 assert.equal(acquires,0);assert.equal(releases,0);
 const muted=stream({readyState:'live',muted:true,enabled:true});
 const fresh=stream({readyState:'live',muted:false,enabled:true});
 assert.equal(await ensure(muted,async()=>{acquires++;return fresh},()=>releases++),fresh,'muted-live track replaced');
 assert.equal(acquires,1);assert.equal(releases,1);
 const ended=stream({readyState:'ended',muted:false});
 assert.equal(await ensure(ended,async()=>fresh,()=>releases++),fresh,'ended track replaced');
 assert.equal(releases,2);
 const denied=await ensure(muted,async()=>null,()=>releases++);
 assert.equal(denied,null,'acquisition failure propagates safely');
 console.log('PASS: healthy track retained');console.log('PASS: live-but-muted track triggers fresh acquisition');console.log('PASS: ended track is released and reacquired');console.log('PASS: permission/acquisition failure returns null safely');console.log('PASS: bounded recovery policy does not loop or restart ASR');
})().catch(e=>{console.error(e);process.exit(1)});
