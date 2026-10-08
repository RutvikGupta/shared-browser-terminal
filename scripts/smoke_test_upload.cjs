// Optional browser integration test: install Playwright separately, or set PLAYWRIGHT_MODULE.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-upload-'));
const env = {...process.env, TMUX_TMPDIR: state}; delete env.TMUX;
const python = process.env.PYTHON || 'python3';
const large = process.env.LARGE_UPLOAD_TEST === '1';
const setup = String.raw`
import sys, socket, json
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1])/'scripts'))
import browser_terminal as terminal
state=Path(sys.argv[2])
fixture=state/'fixture.py'
fixture.write_text("import os,tty,time\nfrom pathlib import Path\ntty.setraw(0)\nos.write(1, ('\\x1b[2J\\x1b[H'+'\\r\\n'.join('Copy sample line %03d alpha beta gamma' % i for i in range(100))).encode())\nwhile True:\n data=os.read(0,1024)\n if data==b'r':\n  for i in range(30):\n   os.write(1,b'\\x1b[?25l\\x1b[1;20H.\\x1b[?25h')\n   time.sleep(0.035)\n with Path(__file__).with_name('input.bin').open('ab') as out: out.write(data)\n")
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
config={'session':'selection-test','port':port,'font_size':14,'cwd':str(state)}
terminal.prepare_state(state)
terminal.run('tmux','-f','/dev/null','new-session','-d','-s',config['session'],'-x','100','-y','30',terminal.shlex.join([sys.executable,str(fixture)]))
terminal.apply_tmux_theme(terminal.find_session(config['session']))
terminal.save_config(state,config)
terminal.ensure_credentials(state)
terminal.restart_ttyd(state,config)
`;
(async () => {
  let browser;
  const receivedDirs=new Set();
  try {
    execFileSync(python,['-c',setup,root,state],{env});
    const config=JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8'));
    const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim();
    const split=login.indexOf(':');
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({httpCredentials:{username:login.slice(0,split),password:login.slice(split+1)},viewport:{width:1200,height:800},permissions:['clipboard-read','clipboard-write']});
    const files=[
      {name:"report ' résumé $(echo test).bin",buffer:Buffer.alloc(large ? 150*1024*1024 : 800000,0xff),mimeType:'application/octet-stream'},
      {name:'second report.bin',buffer:large ? Buffer.alloc(140*1024*1024,0x5a) : Buffer.from(Array.from({length:600000},(_,i)=>i%256)),mimeType:'application/octet-stream'},
      {name:'third.bin',buffer:Buffer.alloc(large ? 145*1024*1024 : 400000,33),mimeType:'application/octet-stream'},
      {name:'empty.txt',buffer:Buffer.alloc(0),mimeType:'text/plain'},
      {name:'last.txt',buffer:Buffer.from('final document'),mimeType:'text/plain'}
    ];
    const pickerFiles=selected=>selected.map((file,index)=>{
      if(!large)return file;
      const folder=path.join(state,'picker-'+index);fs.mkdirSync(folder,{recursive:true});
      const filename=path.join(folder,file.name);fs.writeFileSync(filename,file.buffer);return filename;
    });
    const page=await context.newPage();
    let workersStarted=0;
    page.on('worker',()=>workersStarted++);
    await page.addInitScript(()=>{
      window.startedTransfers=[];
      const Original=Worker;
      window.Worker=class extends Original {
        postMessage(message,...rest){
          if(message.type==='start')window.startedTransfers.push({id:message.transfer.id,name:message.file.name});
          return super.postMessage(message,...rest);
        }
      };
    });
    // Delay synthetic reads inside the actual worker; main-thread File mocks do not cross worker boundaries.
    await page.route('http://127.0.0.1:'+config.port+'/',async route=>{
      const response=await route.fetch();let html=await response.text();
      const hook=`
        const originalSlice=File.prototype.slice, timer=setTimeout;
        let stalled=false, offline=false;
        self.setTimeout=(callback,delay,...args)=>timer(callback,delay===90000?(offline?100:2000):delay,...args);
        File.prototype.slice=function(...args){
          const blob=originalSlice.apply(this,args),read=blob.arrayBuffer.bind(blob);
          if(this.name==='offline.bin'){offline=true;blob.arrayBuffer=()=>new Promise(()=>{});}
          else if(this.name==='stalled.bin'&&!stalled){stalled=true;blob.arrayBuffer=()=>new Promise(()=>{});}
          else blob.arrayBuffer=async()=>{${large?'':'await new Promise(resolve=>timer(resolve,150));'}return read();};
          return blob;
        };
      `;
      html=html.replace('function uploadWorker() {','function uploadWorker() {'+hook);
      await route.fulfill({response,body:html});
    });
    await page.goto('http://127.0.0.1:'+config.port);
    await page.waitForFunction(()=>window.term?.buffer.active.getLine(window.term.buffer.active.viewportY)?.translateToString().includes('Copy sample'));
    // A drop on the terminal must not reach ttyd/trzsz's in-band uploader:
    // that path interrupts the foreground program before typing a receiver command.
    const paneBefore=execFileSync('tmux',['display-message','-p','-t','=selection-test:','#{pane_pid}'],{env,encoding:'utf8'}).trim();
    await page.evaluate(()=>{
      window.dropPaths=[];
      const upload=window.sharedTerminalUpload;
      window.sharedTerminalUpload=async(...args)=>{const saved=await upload(...args);window.dropPaths.push(saved);return saved;};
    });
    const terminalDrop=await page.evaluateHandle(()=>{
      // Synthetic drops need the file-entry API supplied by real OS drags.
      DataTransferItem.prototype.webkitGetAsEntry=function(){
        const file=this.getAsFile();
        return file && {isFile:true,isDirectory:false,name:file.name,fullPath:'/'+file.name,file:resolve=>resolve(file)};
      };
      const data=new DataTransfer();
      data.items.add(new File(['drop without interrupt'],'terminal drop.txt',{type:'text/plain'}));
      data.items.add(new File(['second dropped file'],'another drop.txt',{type:'text/plain'}));
      return data;
    });
    await page.locator('.xterm-screen').dispatchEvent('dragover',{dataTransfer:terminalDrop});
    await page.locator('.xterm-screen').dispatchEvent('drop',{dataTransfer:terminalDrop});
    await page.waitForTimeout(200);
    const rawInput=path.join(state,'input.bin');
    const early=fs.existsSync(rawInput)?fs.readFileSync(rawInput):Buffer.alloc(0);
    assert(!early.includes(3)&&!early.includes(4),'dropping files must not send Ctrl+C or Ctrl+D to the foreground program');
    await page.waitForFunction(()=>window.dropPaths.length===2,{},{timeout:10000});
    await page.locator('#sbt-dialog').waitFor({state:'hidden'});
    const droppedPaths=await page.evaluate(()=>window.dropPaths);
    for(const filename of droppedPaths)receivedDirs.add(path.dirname(filename));
    assert.equal(fs.readFileSync(droppedPaths.find(p=>path.basename(p)==='terminal drop.txt'),'utf8'),'drop without interrupt');
    assert.equal(fs.readFileSync(droppedPaths.find(p=>path.basename(p)==='another drop.txt'),'utf8'),'second dropped file');
    const droppedExpected=' '+['terminal drop.txt','another drop.txt'].map(name=>"'"+droppedPaths.find(p=>path.basename(p)===name)+"'").join(' ')+' ';
    await page.waitForTimeout(200);
    assert.equal(fs.readFileSync(rawInput,'utf8'),droppedExpected,'only completed paths reach the running program, without Enter, interrupts or receiver commands');
    assert.equal(execFileSync('tmux',['display-message','-p','-t','=selection-test:','#{pane_pid}'],{env,encoding:'utf8'}).trim(),paneBefore,'foreground terminal process survives the drop');
    await page.keyboard.type(' still alive');
    for(let i=0;i<100&&fs.readFileSync(rawInput,'utf8')!==droppedExpected+' still alive';i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(rawInput,'utf8'),droppedExpected+' still alive','terminal accepts further input without a reload');
    fs.unlinkSync(rawInput);
    console.log('PASS: direct terminal drop uploads multiple files without interrupting the program; input remains responsive without reload.');
    // Use the real browser clipboard and paste shortcut, not only a synthetic event.
    await page.evaluate(async()=>{
      const upload=window.sharedTerminalUpload;
      window.sharedTerminalUpload=async(file,options)=>{window.pastedPhotoBytes=[...new Uint8Array(await file.arrayBuffer())];return upload(file,options);};
      const canvas=document.createElement('canvas');canvas.width=12;canvas.height=9;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#37a8cd';ctx.fillRect(0,0,12,9);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
      window.term.focus();
    });
    await page.keyboard.press('Meta+v');
    await page.waitForFunction(()=>window.dropPaths.length===3,null,{timeout:15000});
    await page.locator('#sbt-dialog').waitFor({state:'hidden'});
    const photoPath=await page.evaluate(()=>window.dropPaths[2]);receivedDirs.add(path.dirname(photoPath));
    const photoBytes=fs.readFileSync(photoPath);
    assert.deepEqual(photoBytes,Buffer.from(await page.evaluate(()=>window.pastedPhotoBytes)),'upload preserves the image bytes delivered by the clipboard');
    const pixels=await page.evaluate(async bytes=>{
      const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      return {width:canvas.width,height:canvas.height,rgba:[...ctx.getImageData(0,0,1,1).data]};
    },[...photoBytes]);
    assert.deepEqual(pixels,{width:12,height:9,rgba:[55,168,205,255]},'saved photo preserves the copied image pixels');
    const photoInput=" '"+photoPath.replaceAll("'","'\\''")+"' ";
    await page.waitForTimeout(150);
    assert.equal(fs.readFileSync(rawInput,'utf8'),photoInput,'photo paste sends only saved path without Enter or interrupt');
    await page.evaluate(async()=>{await navigator.clipboard.writeText('normal pasted text');window.term.focus();});
    await page.keyboard.press('Meta+v');await page.waitForTimeout(200);
    assert.equal(fs.readFileSync(rawInput,'utf8'),photoInput+'normal pasted text','text paste remains normal terminal input');
    assert.equal(await page.evaluate(()=>window.dropPaths.length),3,'text paste does not upload');
    const mixedPhotos=await page.evaluate(()=>{
      const dt=new DataTransfer();dt.items.add(new File(['synthetic jpeg bytes'],'photo.jpg',{type:'image/jpeg'}));
      dt.items.add(new File(['synthetic webp bytes'],'photo.webp',{type:'image/webp'}));dt.setData('text/plain','do not type this fallback');
      const event=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});
      window.term.element.querySelector('textarea').dispatchEvent(event);return event.defaultPrevented;
    });
    assert(mixedPhotos,'image paste is intercepted before terminal paste handlers');
    await page.waitForFunction(()=>window.dropPaths.length===5,null,{timeout:15000});
    await page.locator('#sbt-dialog').waitFor({state:'hidden'});
    const mixedPaths=await page.evaluate(()=>window.dropPaths.slice(3));mixedPaths.forEach(p=>receivedDirs.add(path.dirname(p)));
    assert.equal(fs.readFileSync(mixedPaths.find(p=>p.endsWith('.jpg')),'utf8'),'synthetic jpeg bytes');
    assert.equal(fs.readFileSync(mixedPaths.find(p=>p.endsWith('.webp')),'utf8'),'synthetic webp bytes');
    assert(!fs.readFileSync(rawInput,'utf8').includes('do not type this fallback'),'image text fallback is never sent to the program');
    assert.equal(execFileSync('tmux',['display-message','-p','-t','=selection-test:','#{pane_pid}'],{env,encoding:'utf8'}).trim(),paneBefore,'foreground process survives photo paste');
    fs.unlinkSync(rawInput);
    console.log('PASS: real clipboard PNG paste uploads exact bytes and inserts its path; text paste is preserved; multiple images suppress text fallback without interrupting the command.');
    await page.evaluate(()=>{
      window.term.paste('existing draft');
      window.savedPaths=[];
      const upload=window.sharedTerminalUpload;
      window.sharedTerminalUpload=async(...args)=>{const path=await upload(...args);window.savedPaths.push(path);return path;};
      window.maxUploads=0;window.sawPartial=false;window.rowCounts=[];
      window.sampler=setInterval(()=>{
        const rows=[...document.querySelectorAll('.sbt-file')];
        window.maxUploads=Math.max(window.maxUploads,rows.filter(row=>row.dataset.state==='uploading').length);
        window.sawPartial ||= rows.some(row=>{const p=row.querySelector('progress');return p.value>0&&p.value<1;});
        window.rowCounts.push(rows.length);
      },10);
    });
    execFileSync('tmux',['copy-mode','-t','=selection-test:'],{env});
    assert.equal(execFileSync('tmux',['display-message','-p','-t','=selection-test:','#{pane_mode}'],{env,encoding:'utf8'}).trim(),'copy-mode');
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    assert(await page.locator('#sbt-file-input').getAttribute('multiple')!==null);
    assert.equal(await page.locator('#sbt-concurrency').count(),0,'no concurrency setting is required');
    await page.screenshot({path:path.join(os.tmpdir(),'sbt-upload-empty.png')});
    await page.locator('#sbt-file-input').setInputFiles(pickerFiles(files.slice(0,4)));
    const dropped=await page.evaluateHandle(()=>{
      const data=new DataTransfer();data.items.add(new File(['final document'],'last.txt',{type:'text/plain'}));return data;
    });
    await page.locator('#sbt-drop').dispatchEvent('drop',{dataTransfer:dropped});
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file[data-state="complete"]').length===5,{},{timeout:large ? 180000 : 30000});
    const saved=await page.evaluate(()=>window.savedPaths);
    const paths=files.map(file=>saved.find(p=>path.basename(p)===file.name));
    paths.forEach(p=>receivedDirs.add(path.dirname(p)));
    for(let i=0;i<files.length;i++)assert.deepEqual(fs.readFileSync(paths[i]),files[i].buffer,'exact binary content');
    await page.locator('#sbt-dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.term.element.contains(document.activeElement));
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    assert(await page.locator('#sbt-dialog').isVisible(),'reopening shows the file picker');
    assert.equal(await page.locator('.sbt-file').count(),0,'finished uploads are cleared when reopening');
    const observation=await page.evaluate(()=>({max:window.maxUploads,partial:window.sawPartial}));
    assert(workersStarted>=5,'every selected file starts its own worker');
    assert(observation.max>=4,'uploads are no longer limited to three active transfers');
    assert(observation.partial,'receiver-acknowledged intermediate progress is displayed');
    let expected='existing draft '+paths.map(p=>"'"+p.replaceAll("'","'\\''")+"'").join(' ')+' ';
    const input=path.join(state,'input.bin');
    for(let i=0;i<100&&(!fs.existsSync(input)||fs.readFileSync(input,'utf8')!==expected);i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(input,'utf8'),expected,'all paths insert once, without clearing draft or Enter');
    await page.locator('#sbt-insert-paths').uncheck();
    // An invalid filename fails only its own row; queued files continue.
    const more=[{name:'bad\nname.txt',buffer:Buffer.from('bad'),mimeType:'text/plain'},files[4]];
    await page.locator('#sbt-file-input').setInputFiles(more);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file[data-state="failed"]').length===1&&document.querySelectorAll('.sbt-file[data-state="complete"]').length===1);
    const duplicate=await page.evaluate(()=>window.savedPaths[5]);
    receivedDirs.add(path.dirname(duplicate));assert.notEqual(duplicate,paths[4]);
    assert.equal(fs.readFileSync(input,'utf8'),expected,'opt-out sends no extra input');
    // Keep the persistent completed rows while a new file is canceled and retried.
    await page.locator('#sbt-file-input').setInputFiles(pickerFiles([files[0]]));
    const canceled=page.locator('.sbt-file').nth(2);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[2].dataset.state==='uploading');
    await canceled.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[2].dataset.state==='canceled');
    assert.equal(await page.locator('.sbt-file').count(),3);
    await canceled.getByRole('button',{name:'Retry',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[2].dataset.state==='complete',{},{timeout:large ? 180000 : 30000});
    const retried=await page.evaluate(()=>window.savedPaths[6]);receivedDirs.add(path.dirname(retried));
    assert.deepEqual(fs.readFileSync(retried),files[0].buffer);
    assert.equal(fs.readFileSync(input,'utf8'),expected);
    await page.getByRole('button',{name:'Close upload dialog'}).click();
    await page.waitForFunction(()=>window.term.element.contains(document.activeElement));
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    assert.equal(await page.locator('.sbt-file').count(),1,'reopening clears finished rows but retains failed uploads for retry');
    // A receiver that accepts a file but receives no bytes times out visibly;
    // it reconnects automatically and completes once file reads recover.
    await page.locator('#sbt-file-input').setInputFiles([{name:'stalled.bin',buffer:Buffer.from('recover me'),mimeType:'application/octet-stream'}]);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[1].dataset.state==='uploading');
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[1].dataset.state==='reconnecting');
    assert.match(await page.locator('.sbt-file').nth(1).textContent(),/Reconnecting/);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[1].dataset.state==='complete');
    const recovered=await page.evaluate(()=>window.savedPaths[7]);
    receivedDirs.add(path.dirname(recovered));assert.equal(fs.readFileSync(recovered,'utf8'),'recover me');
    assert.equal(fs.readFileSync(input,'utf8'),expected);
    await page.screenshot({path:path.join(os.tmpdir(),'sbt-upload-progress.png')});
    // A disconnected input must retain saved paths and allow retry without reupload.
    await page.reload();
    await page.waitForFunction(()=>window.term && !document.querySelector('#sbt-bottom').disabled);
    await page.evaluate(()=>{
      window.normalPrepare=window.sharedTerminalPrepareInput;
      window.sharedTerminalPrepareInput=async()=>{throw new Error('Terminal disconnected. Retry inserting paths.');};
      window.savedPaths=[];
      const upload=window.sharedTerminalUpload;
      window.sharedTerminalUpload=async(...args)=>{const p=await upload(...args);window.savedPaths.push(p);return p;};
    });
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    await page.locator('#sbt-file-input').setInputFiles([files[4]]);
    await page.locator('#sbt-retry-paths').waitFor({state:'visible'});
    assert(await page.locator('#sbt-dialog').isVisible(),'insertion failure keeps dialog open');
    assert.equal(fs.readFileSync(input,'utf8'),expected,'failed insertion sends no input');
    const retained=await page.evaluate(()=>window.savedPaths[0]);receivedDirs.add(path.dirname(retained));
    await page.getByRole('button',{name:'Close upload dialog'}).click();
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    assert.equal(await page.locator('.sbt-file').count(),1,'a saved path awaiting insertion survives reopening');
    assert(await page.locator('#sbt-retry-paths').isVisible());
    await page.evaluate(()=>{window.sharedTerminalPrepareInput=window.normalPrepare;});
    await page.locator('#sbt-retry-paths').click();
    await page.locator('#sbt-dialog').waitFor({state:'hidden'});
    expected+=" '"+retained+"' ";
    for(let i=0;i<100&&fs.readFileSync(input,'utf8')!==expected;i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(input,'utf8'),expected,'retry inserts the retained path once');
    assert.equal(await page.evaluate(()=>window.savedPaths.length),1,'insertion retry does not reupload');
    // A failed sibling must not block successfully saved files from reaching input.
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    await page.locator('#sbt-file-input').setInputFiles(more);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file[data-state="failed"]').length===1&&document.querySelectorAll('.sbt-file[data-state="complete"]').length===1);
    const partial=await page.evaluate(()=>window.savedPaths[1]);receivedDirs.add(path.dirname(partial));
    expected+=" '"+partial+"' ";
    for(let i=0;i<100&&fs.readFileSync(input,'utf8')!==expected;i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(input,'utf8'),expected,'failed sibling does not block a saved path');
    assert(await page.locator('#sbt-dialog').isVisible(),'upload failures remain available for retry');
    // A blocked UI thread must not stop worker reads, acknowledgements, or saving.
    await page.reload();
    await page.waitForFunction(()=>window.sharedTerminalUpload);
    await page.evaluate(()=>{
      window.threadTest=window.sharedTerminalUpload(new File([new Uint8Array(2*1024**2)],'worker-thread.bin'),{
        signal:new AbortController().signal,onState:state=>window.threadState=state,onProgress:()=>{}
      });
    });
    await page.waitForFunction(()=>window.threadState==='uploading');
    const transfer=await page.evaluate(()=>window.startedTransfers.find(item=>item.name==='worker-thread.bin'));
    const folder=path.join(os.homedir(),'Downloads/terminal-uploads','upload-'+transfer.id);
    receivedDirs.add(folder);
    let startedBlock;
    const blocking=new Promise(resolve=>{startedBlock=resolve;});
    await page.exposeFunction('reportUiBlocked',()=>startedBlock());
    const blocked=page.evaluate(()=>{
      window.reportUiBlocked();
      const start=performance.now();while(performance.now()-start<4000){}
    });
    await blocking;
    const savedDuringBlock=path.join(folder,'worker-thread.bin');
    const deadline=Date.now()+3000;
    while(!fs.existsSync(savedDuringBlock)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    const completedWhileBlocked=fs.existsSync(savedDuringBlock);
    await blocked;
    assert(completedWhileBlocked,'the worker must finish saving while the UI thread is blocked');
    assert.equal(await page.evaluate(()=>window.threadTest),savedDuringBlock);
    assert.deepEqual(fs.readFileSync(savedDuringBlock),Buffer.alloc(2*1024**2));
    const stalledResult=await page.evaluate(async()=>{
      const states=[];
      try {
        await window.sharedTerminalUpload(new File(['never sent'],'offline.bin'),{
          signal:new AbortController().signal,onState:state=>states.push(state),onProgress:()=>{}
        });
        return {states};
      } catch(error){return {states,error:error.message};}
    });
    const stalledTransfer=await page.evaluate(()=>window.startedTransfers.find(item=>item.name==='offline.bin'));
    receivedDirs.add(path.join(os.homedir(),'Downloads/terminal-uploads','upload-'+stalledTransfer.id));
    assert.match(stalledResult.error,/timed out/);
    assert.equal(stalledResult.states.filter(state=>state==='uploading').length,5,'five attempts without progress stop automatically');
    assert.equal(stalledResult.states.filter(state=>state==='reconnecting').length,4);
    console.log('PASS: a stalled upload stops after five attempts without saved progress.');
    console.log('PASS: upload completes and saves exact bytes while the UI thread is deliberately blocked.');
    console.log('PASS: copy-mode upload exits history before inserting; insertion failure retains paths for retry; successful paths insert despite a failed sibling.');
    console.log('PASS: concurrent binary uploads with acknowledged intermediate progress; persistent per-file rows; empty/Unicode/duplicate names; exact path insertion; opt-out; independent failure; cancel/retry; fresh popup after completion and retained unfinished work.');
  } finally {
    if(browser)await browser.close();
    for(const folder of receivedDirs){
      fs.rmSync(folder,{recursive:true,force:true});
      const id=path.basename(folder).replace(/^upload-/,'');
      if(/^[a-f0-9]{32}$/.test(id))fs.rmSync(path.join(path.dirname(folder),'.transfers',id),{recursive:true,force:true});
    }
    const cleanup=String.raw`
import sys, subprocess
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'scripts'))
import browser_terminal as terminal
state=Path(sys.argv[2]); config=terminal.read_config(state)
terminal.stop_process(state,config,'ttyd')
subprocess.run(['tmux','kill-server'],capture_output=True)
`;
    try{execFileSync(python,['-c',cleanup,root,state],{env});}
    finally{fs.rmSync(state,{recursive:true,force:true});}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
