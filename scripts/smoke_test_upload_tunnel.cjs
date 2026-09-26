// Optional real-tunnel test: synthetic bytes only; never sends terminal input.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync,execFile}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),state=process.argv[2];
if(!state)throw new Error('Pass the managed terminal state directory.');
const sizes=[9,140,151,144,75];
const rounds=Number(process.env.UPLOAD_TEST_ROUNDS || 2);
const faults=process.env.UPLOAD_TEST_FAULTS !== '0';
const restartReceiver=process.env.UPLOAD_TEST_RESTART === '1';
if(restartReceiver && !JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8')).session.startsWith('sbt-resume-validation'))throw new Error('Receiver restart is restricted to an isolated validation terminal.');
(async()=>{
  const url=execFileSync('python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;print(t.read_url(Path(sys.argv[2])))",path.join(root,'scripts'),state],{encoding:'utf8'}).trim();
  const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim(),split=login.indexOf(':');
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({httpCredentials:{username:login.slice(0,split),password:login.slice(split+1)}});
  try {
    // Test the source transport against the authenticated public receiver without attaching a shell.
    await context.route(url+'/',route=>route.fulfill({contentType:'text/html',body:'<html><body>'+fs.readFileSync(path.join(root,'assets/upload-transport.html'),'utf8')+'</body></html>'}));
    const page=await context.newPage();
    page.on('console',message=>console.log(message.text()));
    await page.exposeFunction('restartTestReceiver',()=>new Promise((resolve,reject)=>{
      execFile('python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);t.restart_ttyd(s,t.read_config(s))",path.join(root,'scripts'),state],error=>error?reject(error):resolve());
    }));
    await page.goto(url+'/');
    for(let round=0;round<rounds;round++){
      const result=await page.evaluate(async({sizes,faults,round,restartReceiver})=>{
        const Original=WebSocket,sockets=new Map(),offsets=[],ids=new Set();
        let finalDropped=false,midDrops=0,next=0,retries=0,manualRetries=0,serverRestart;
        window.WebSocket=class extends Original {
          constructor(...args){
            super(...args);
            this.addEventListener('message',event=>{
              const text=new TextDecoder().decode(new Uint8Array(event.data).subarray(1));
              for(const line of text.split('\n')){
                let message;try{message=JSON.parse(line);}catch{continue;}
                if(message.type==='accepted' && message.offset>0)offsets.push(message.offset);
                if(faults && this.uploadName?.includes('-1.bin') && message.type==='saved' && !finalDropped){
                  finalDropped=true;event.stopImmediatePropagation();this.close();return;
                }
              }
            });
          }
          send(data){
            const bytes=new Uint8Array(data);
            if(bytes[0]===48 && bytes[1]===123){
              try{const header=JSON.parse(new TextDecoder().decode(bytes.subarray(1)));if(header.id){this.uploadName=header.name;sockets.set(header.name,this);ids.add(header.id);}}catch{}
            }
            super.send(data);
          }
        };
        const results=[],progress=new Array(sizes.length).fill(0),start=performance.now();
        const timer=setInterval(()=>console.log('Round '+(round+1)+' acknowledged MiB: '+progress.map(n=>(n/1024**2).toFixed(1)).join(', ')),15000);
        async function worker(){
          while(next<sizes.length){
            const n=next++,bytes=new Uint8Array(sizes[n]*1024**2);
            for(let start=0;start<bytes.length;start+=65536)crypto.getRandomValues(bytes.subarray(start,Math.min(start+65536,bytes.length)));
            const expectedHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
            const name='synthetic-round-'+round+'-'+n+'.bin',file=new File([bytes],name);
            let forced=0;
            const options={signal:new AbortController().signal,
              onState:s=>{if(s==='reconnecting')retries++;},
              onProgress:p=>{
                progress[n]=p;
                if(restartReceiver && n===3 && p>=2*1024**2 && !serverRestart)serverRestart=window.restartTestReceiver();
                // Drop two in-flight connections, plus six on another file to exhaust automatic retries.
                const count=n===0?2:n===2?6:0;
                if(faults && forced<count && p>=(forced+1)*1024**2){
                  forced++;midDrops++;sockets.get(name)?.close();
                }
              }};
            try{
              let saved;
              try{saved=await window.sharedTerminalUpload(file,options);}
              catch(error){if(!faults || n!==2 || !forced)throw error;manualRetries++;saved=await window.sharedTerminalUpload(file,options);}
              results.push({path:saved,n,progress:progress[n],expectedHash});
            }catch(error){results.push({error:error.message,n,progress:progress[n]});}
          }
        }
        try{await Promise.all([worker(),worker(),worker()]);if(serverRestart)await serverRestart;}
        finally{clearInterval(timer);window.WebSocket=Original;}
        return {results,ids:[...ids],seconds:(performance.now()-start)/1000,offsets,retries,manualRetries,midDrops,finalDropped,serverRestarted:!!serverRestart};
      },{sizes,faults,round,restartReceiver});
      for(const entry of result.results){
        if(!entry.path)continue;
        try{
          const data=fs.readFileSync(entry.path);
          entry.valid=crypto.createHash('sha256').update(data).digest('hex')===entry.expectedHash;
          delete entry.expectedHash;
          entry.bytes=data.length;
        }finally{fs.rmSync(path.dirname(entry.path),{recursive:true});delete entry.path;}
      }
      // Remove only private caches created by this synthetic test.
      for(const id of result.ids){
        assert(/^[a-f0-9]{32}$/.test(id));
        const uploads=path.join(require('node:os').homedir(),'Downloads/terminal-uploads');
        fs.rmSync(path.join(uploads,'.transfers',id),{recursive:true,force:true});
        fs.rmSync(path.join(uploads,'upload-'+id),{recursive:true,force:true});
      }
      delete result.ids;
      console.log(JSON.stringify({round:round+1,...result}));
      assert.equal(result.results.length,sizes.length);
      assert(result.results.every(entry=>entry.valid&&entry.bytes===entry.progress),'all files must finish with matching SHA-256 hashes');
      if(faults){assert.equal(result.midDrops,8);assert(result.finalDropped);assert(result.offsets.length>=9);assert.equal(result.manualRetries,0);}
      if(restartReceiver)assert(result.serverRestarted);
      console.log('PASS: '+sizes.reduce((a,b)=>a+b,0)+' MiB, three transfers at a time, '+result.seconds.toFixed(1)+' s, '+(sizes.reduce((a,b)=>a+b,0)/result.seconds).toFixed(2)+' MiB/s.');
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
