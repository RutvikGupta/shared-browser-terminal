// Real-tunnel benchmark and recovery test: synthetic bytes only, no terminal input.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync,execFile}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),state=process.argv[2];
if(!state)throw new Error('Pass the managed terminal state directory.');
const sizes=JSON.parse(process.env.UPLOAD_TEST_SIZES || '[9,140,151,144,75]');
const rounds=Number(process.env.UPLOAD_TEST_ROUNDS || 2),faults=process.env.UPLOAD_TEST_FAULTS !== '0';
const concurrency=Number(process.env.UPLOAD_TEST_CONCURRENCY || sizes.length);
const forcedDrops=Number(process.env.UPLOAD_TEST_DROPS || 6);
const restartReceiver=process.env.UPLOAD_TEST_RESTART === '1';
if(restartReceiver && !JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8')).session.startsWith('sbt-resume-validation'))throw new Error('Receiver restart requires an isolated validation terminal.');

// Injected only into test pages/workers; production code has no fault controls.
function installProbe(faults,forcedDrops){
  const Original=WebSocket,states=new Map();
  const report=(kind,data)=>{
    const message={kind,...data};
    if(typeof document==='undefined')self.postMessage({type:'test-probe',message});
    else window.recordUploadProbe(message);
  };
  self.WebSocket=class extends Original {
    constructor(...args){
      super(...args);
      let opened=false;
      this.addEventListener('open',()=>{opened=true;report('socket-open',{});});
      this.addEventListener('close',event=>{if(opened)report('socket-close',{code:event.code,reason:event.reason});});
      this.addEventListener('message',event=>{
        const text=new TextDecoder().decode(new Uint8Array(event.data).subarray(1));
        for(const line of text.split('\n')){
          let message;try{message=JSON.parse(line);}catch{continue;}
          if(message.type==='accepted'&&message.offset>0)report('resume',{bytes:message.offset});
          if(!this.probe)continue;
          const entry=this.probe;
          if(message.type==='progress'){
            if(entry.name.endsWith('-3.bin')&&message.bytes>=2*1024**2&&!entry.restartReported){entry.restartReported=true;report('progress',{name:entry.name,bytes:message.bytes});}
            const count=entry.name.endsWith('-0.bin')?2:entry.name.endsWith('-2.bin')?forcedDrops:0;
            if(faults&&entry.drops<count&&message.bytes>=(entry.drops+1)*1024**2){
              entry.drops++;report('drop',{});this.close();
            }
          }
          if(faults&&entry.name.endsWith('-1.bin')&&message.type==='saved'&&!entry.finalDropped){
            entry.finalDropped=true;report('final-drop',{});event.stopImmediatePropagation();this.close();return;
          }
        }
      });
    }
    send(data){
      const bytes=new Uint8Array(data);
      if(bytes[0]===48&&bytes[1]===123){
        try{
          const header=JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if(header.id){
            if(!states.has(header.id))states.set(header.id,{name:header.name,drops:0,finalDropped:false});
            this.probe=states.get(header.id);report('id',{id:header.id});
          }
        }catch{}
      }
      super.send(data);
    }
  };
}
(async()=>{
  const url=process.env.UPLOAD_TEST_LOCAL === '1'
    ? 'http://127.0.0.1:'+JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8')).port
    : execFileSync('python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;print(t.read_url(Path(sys.argv[2])))",path.join(root,'scripts'),state],{encoding:'utf8'}).trim();
  const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim(),split=login.indexOf(':');
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({httpCredentials:{username:login.slice(0,split),password:login.slice(split+1)}});
  try{
    let html=fs.readFileSync(process.env.UPLOAD_TEST_TRANSPORT || path.join(root,'assets/upload-transport.html'),'utf8');
    const threaded=html.includes('function uploadWorker() {');
    if(threaded){
      html=html.replace('function uploadWorker() {','function uploadWorker() {('+installProbe.toString()+')('+JSON.stringify(faults)+','+forcedDrops+');');
      html=html.replace('stalled = transfer.progress > before ? 0 : stalled + 1;',
        "stalled = transfer.progress > before ? 0 : stalled + 1; self.postMessage({type:'test-probe',message:{kind:'retry',reason:error.message}});");
    }
    await context.route(url+'/',route=>route.fulfill({contentType:'text/html',body:'<html><body>'+html+'</body></html>'}));
    await context.addInitScript(({faults,forcedDrops,restartReceiver,probe})=>{
      window.resetProbe=()=>{window.uploadProbe={ids:new Set(),offsets:[],drops:0,finalDropped:0,workers:0,maxWorkers:0,activeWorkers:0,sockets:0,maxSockets:0,closeCodes:{},retryReasons:{},serverRestart:null};};
      window.resetProbe();
      window.recordUploadProbe=message=>{
        const p=window.uploadProbe;
        if(message.kind==='id')p.ids.add(message.id);
        if(message.kind==='socket-open'){p.sockets++;p.maxSockets=Math.max(p.maxSockets,p.sockets);}
        if(message.kind==='socket-close'){p.sockets--;p.closeCodes[message.code]=(p.closeCodes[message.code]||0)+1;}
        if(message.kind==='retry')p.retryReasons[message.reason]=(p.retryReasons[message.reason]||0)+1;
        if(message.kind==='resume')p.offsets.push(message.bytes);
        if(message.kind==='drop')p.drops++;
        if(message.kind==='final-drop')p.finalDropped++;
        if(restartReceiver&&message.kind==='progress'&&message.name.endsWith('-3.bin')&&message.bytes>=2*1024**2&&!p.serverRestart)p.serverRestart=window.restartTestReceiver();
      };
      const Original=Worker;
      window.Worker=class extends Original {
        constructor(...args){
          super(...args);this.finished=false;this.openSockets=0;
          const p=window.uploadProbe;p.workers++;p.activeWorkers++;p.maxWorkers=Math.max(p.maxWorkers,p.activeWorkers);
          this.addEventListener('message',event=>{if(!this.finished&&event.data.type==='test-probe'){
            if(event.data.message.kind==='socket-open')this.openSockets++;
            if(event.data.message.kind==='socket-close')this.openSockets--;
            window.recordUploadProbe(event.data.message);
          }});
        }
        terminate(){if(!this.finished){this.finished=true;window.uploadProbe.activeWorkers--;window.uploadProbe.sockets-=this.openSockets;}super.terminate();}
      };
      // The baseline implementation runs on the main thread.
      (0,eval)('('+probe+')('+JSON.stringify(faults)+','+forcedDrops+')');
    },{faults,forcedDrops,restartReceiver,probe:installProbe.toString()});
    const page=await context.newPage();page.on('console',message=>console.log(message.text()));
    await page.exposeFunction('restartTestReceiver',()=>new Promise((resolve,reject)=>{
      execFile('python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);t.restart_ttyd(s,t.read_config(s))",path.join(root,'scripts'),state],error=>error?reject(error):resolve());
    }));
    await page.goto(url+'/');
    for(let round=0;round<rounds;round++){
      const result=await page.evaluate(async({sizes,round,concurrency})=>{
        window.resetProbe();
        const files=[],hashes=[];
        for(let n=0;n<sizes.length;n++){
          const bytes=new Uint8Array(sizes[n]*1024**2);
          for(let start=0;start<bytes.length;start+=65536)crypto.getRandomValues(bytes.subarray(start,Math.min(start+65536,bytes.length)));
          hashes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join(''));
          files.push(new File([bytes],'synthetic-round-'+round+'-'+n+'.bin'));
        }
        const results=[],progress=new Array(sizes.length).fill(0),start=performance.now();
        let next=0,retries=0,maxLag=0,lastTick=start;
        const tick=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-lastTick-50);lastTick=now;},50);
        const timer=setInterval(()=>console.log('Round '+(round+1)+' acknowledged MiB: '+progress.map(n=>(n/1024**2).toFixed(1)).join(', ')),15000);
        async function uploadNext(){
          while(next<files.length){
            const n=next++;
            try{
              const saved=await window.sharedTerminalUpload(files[n],{signal:new AbortController().signal,onState:s=>{if(s==='reconnecting')retries++;},onProgress:p=>progress[n]=p});
              results.push({path:saved,n,progress:progress[n],expectedHash:hashes[n]});
            }catch(error){results.push({error:error.message,n,progress:progress[n]});}
          }
        }
        try{await Promise.all(Array.from({length:Math.min(concurrency,files.length)},uploadNext));if(window.uploadProbe.serverRestart)await window.uploadProbe.serverRestart;}
        finally{clearInterval(timer);clearInterval(tick);}
        const p=window.uploadProbe;
        return {results,ids:[...p.ids],seconds:(performance.now()-start)/1000,maxMainThreadLagMs:maxLag,retries,retryReasons:p.retryReasons,offsets:p.offsets,midDrops:p.drops,finalDropped:p.finalDropped,serverRestarted:!!p.serverRestart,workers:p.workers,maxWorkers:p.maxWorkers,activeWorkers:p.activeWorkers,maxSockets:p.maxSockets,closeCodes:p.closeCodes};
      },{sizes,round,concurrency});
      for(const entry of result.results){
        if(!entry.path)continue;
        try{const data=fs.readFileSync(entry.path);entry.valid=crypto.createHash('sha256').update(data).digest('hex')===entry.expectedHash;entry.bytes=data.length;delete entry.expectedHash;}
        finally{fs.rmSync(path.dirname(entry.path),{recursive:true});delete entry.path;}
      }
      for(const id of result.ids){
        assert(/^[a-f0-9]{32}$/.test(id));const uploads=path.join(require('node:os').homedir(),'Downloads/terminal-uploads');
        fs.rmSync(path.join(uploads,'.transfers',id),{recursive:true,force:true});fs.rmSync(path.join(uploads,'upload-'+id),{recursive:true,force:true});
      }
      delete result.ids;console.log(JSON.stringify({round:round+1,...result}));
      assert.equal(result.results.length,sizes.length);assert(result.results.every(entry=>entry.valid&&entry.bytes===entry.progress),'all files must finish with matching SHA-256 hashes');
      if(threaded){assert.equal(result.workers,sizes.length);assert.equal(result.maxWorkers,Math.min(concurrency,sizes.length));assert.equal(result.activeWorkers,0);}
      if(faults){assert.equal(result.midDrops,forcedDrops+2);assert.equal(result.finalDropped,1);assert(result.offsets.length>=forcedDrops+3);}
      if(restartReceiver)assert(result.serverRestarted);
      console.log('PASS: '+sizes.reduce((a,b)=>a+b,0)+' MiB, '+concurrency+' simultaneous uploads, '+result.seconds.toFixed(1)+' s, '+(sizes.reduce((a,b)=>a+b,0)/result.seconds).toFixed(2)+' MiB/s.');
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
