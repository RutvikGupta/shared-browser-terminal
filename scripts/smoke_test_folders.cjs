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
const publicTest = process.env.FOLDER_TEST_PUBLIC === '1';
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

(async()=>{
 let browser;
 const destinations=new Set(),ids=new Set();
 const uploads=path.join(os.homedir(),'Downloads/terminal-uploads');
 try {
  execFileSync(python,['-c',setup,root,state],{env});
  const config=JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8'));
  let url='http://127.0.0.1:'+config.port;
  if(publicTest) url=execFileSync(python,['-c',`import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);reason,_=t.wait_for_public(s,t.read_config(s),45);assert reason is None,reason;print(t.read_url(s))`,path.join(root,'scripts'),state],{env,encoding:'utf8'}).trim();
  const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim(),split=login.indexOf(':');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({httpCredentials:{username:login.slice(0,split),password:login.slice(split+1)},viewport:{width:1200,height:800}});
  const page=await context.newPage();
  await page.exposeFunction('recordTransfer',transfer=>{ids.add(transfer.id);destinations.add(transfer.destination?.group || transfer.id);});
  await page.addInitScript(()=>{
   const Original=Worker;
   window.Worker=class extends Original {
    postMessage(message,...rest){if(message.type==='start')window.recordTransfer(message.transfer);return super.postMessage(message,...rest);}
   };
  });
  await page.route(url+'/',async route=>{
   const response=await route.fetch();
   // Lose one progress acknowledgement and the final save acknowledgement;
   // each file's worker must resume in the same folder without retransmission.
   const hook=`
    let midDrop=false,finalDrop=false;
    const Original=WebSocket;
    self.WebSocket=class extends Original {
     constructor(...args){super(...args);this.addEventListener('message',event=>{
      const text=new TextDecoder().decode(new Uint8Array(event.data).subarray(1));
      for(const line of text.split('\\n')){let data;try{data=JSON.parse(line);}catch{continue;}
       if(data.type==='progress'&&!midDrop){midDrop=true;this.close();}
       if(data.type==='saved'&&!finalDrop){finalDrop=true;event.stopImmediatePropagation();this.close();}
      }
     });}
    };
   `;
   await route.fulfill({response,body:(await response.text()).replace('function uploadWorker() {','function uploadWorker() {'+hook)});
  });
  await page.goto(url);
  await page.waitForFunction(()=>window.term && window.sharedTerminalUpload && !document.querySelector('#sbt-bottom').disabled);
  await page.evaluate(()=>{
   window.saved=[];window.uploadStates=[];
   const original=window.sharedTerminalUpload;
   window.sharedTerminalUpload=async(file,options)=>{
    const onState=options.onState;
    const saved=await original(file,{...options,onState:s=>{window.uploadStates.push(s);onState(s);}});
    window.saved.push({relative:options.destination?.relative,path:saved});return saved;
   };
  });
  const folder=path.join(state,"folder ' résumé");
  const contents={'a/report.bin':Buffer.alloc(300000,213),'b/report.bin':Buffer.alloc(180000,33),'empty.txt':Buffer.alloc(0)};
  for(const [name,data] of Object.entries(contents)){const p=path.join(folder,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);}
  const raw=path.join(state,'input.bin');
  await page.evaluate(()=>window.term.paste('existing draft'));
  await page.locator('#sbt-upload').click();
  assert(!(await page.locator('#sbt-choose-folder').isVisible()),'folder choice is hidden under Browse');
  await page.locator('#sbt-choose').click();
  await page.keyboard.press('Escape');
  assert(!(await page.locator('#sbt-choose-folder').isVisible()),'Escape closes Browse choices');
  assert(await page.locator('#sbt-dialog').isVisible(),'Escape keeps the upload dialog open');
  await page.locator('#sbt-choose').click();
  await page.locator('#sbt-upload-title').click();
  assert(!(await page.locator('#sbt-choose-folder').isVisible()),'outside click closes Browse choices');
  await page.locator('#sbt-choose').click();
  const fileChooser=page.waitForEvent('filechooser');await page.locator('#sbt-choose-files').click();await (await fileChooser).setFiles([]);
  assert(!(await page.locator('#sbt-choose-folder').isVisible()),'choosing files closes Browse choices');
  await page.locator('#sbt-choose').click();
  const chooser=page.waitForEvent('filechooser');await page.locator('#sbt-choose-folder').click();await (await chooser).setFiles(folder);
  await page.waitForFunction(()=>window.saved.length===3,null,{timeout:90000});
  await page.locator('#sbt-dialog').waitFor({state:'hidden',timeout:15000});
  const saved=await page.evaluate(()=>window.saved);
  const rootFolder=saved[0].path.slice(0,-saved[0].relative.length)+path.basename(folder);
  for(const [name,data] of Object.entries(contents))assert.deepEqual(fs.readFileSync(path.join(rootFolder,name)),data);
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  await page.waitForTimeout(300);
  assert.equal(fs.readFileSync(raw,'utf8'),'existing draft '+quote(rootFolder)+' ','only the folder path inserts once; draft and Enter are untouched');
  assert((await page.evaluate(()=>window.uploadStates)).includes('reconnecting'),'folder transfers recover from forced disconnects');
  console.log('PASS: native folder picker preserves nested duplicate names, binary bytes and empty files; resumes after lost progress/completion, inserts one folder path, and closes.');
  fs.unlinkSync(raw);
  await page.evaluate(()=>{window.saved=[];const original=window.sharedTerminalUpload;let failed=false;window.sharedTerminalUpload=(file,options)=>{if(file.name==='retry.txt'&&!failed){failed=true;return Promise.reject(new Error('Synthetic temporary failure'));}return original(file,options);};});
  const drop=await page.evaluateHandle(()=>{
   const file=(name,text)=>({name,isFile:true,isDirectory:false,file:resolve=>resolve(new File([text],name))});
   const dir=(name,children)=>({name,isFile:false,isDirectory:true,createReader(){let offset=0;return {readEntries(resolve){resolve(children.slice(offset,++offset));}};}});
   const entry=dir('Dropped folder',[dir('a',[file('same.txt','first')]),dir('b',[file('same.txt','second')]),dir('empty',[]),file('retry.txt','retry data')]);
   const dt=new DataTransfer();dt.items.add(new File([],'Dropped folder'));
   DataTransferItem.prototype.webkitGetAsEntry=function(){return entry;};return dt;
  });
  await page.locator('.xterm-screen').dispatchEvent('drop',{dataTransfer:drop});
  await page.waitForFunction(()=>document.querySelectorAll('.sbt-file[data-state="failed"]').length===1&&document.querySelectorAll('.sbt-file[data-state="complete"]').length===6,null,{timeout:90000});
  assert(!fs.existsSync(raw),'incomplete folder must not insert a misleading completed path');
  await page.locator('.sbt-file[data-state="failed"]').getByRole('button',{name:'Retry',exact:true}).click();
  await page.locator('#sbt-dialog').waitFor({state:'hidden',timeout:90000});
  const dropped=await page.evaluate(()=>window.saved);
  const rootDrop=dropped.find(x=>x.relative==='Dropped folder').path;
  assert.equal(fs.readFileSync(path.join(rootDrop,'a/same.txt'),'utf8'),'first');
  assert.equal(fs.readFileSync(path.join(rootDrop,'b/same.txt'),'utf8'),'second');
  assert.equal(fs.readFileSync(path.join(rootDrop,'retry.txt'),'utf8'),'retry data');
  assert.deepEqual(fs.readdirSync(path.join(rootDrop,'empty')),[]);
  await page.waitForTimeout(300);
  assert.equal(fs.readFileSync(raw,'utf8'),' '+quote(rootDrop)+' ','retry inserts folder once, without command/interrupt keys');
  console.log('PASS: recursive directory drop reads every batch, preserves empty subfolders, keeps failures available for retry, and waits for the whole folder before insertion.');
  await page.locator('#sbt-upload').click();assert.equal(await page.locator('.sbt-file').count(),0);
  await page.screenshot({path:path.join(os.tmpdir(),'sbt-folder-upload.png')});
  await page.getByRole('button',{name:'Close upload dialog'}).click();
  const before=ids.size;
  const slow=await page.evaluateHandle(()=>{
   DataTransferItem.prototype.webkitGetAsEntry=function(){return {name:'slow folder',isDirectory:true,createReader(){return {readEntries:resolve=>setTimeout(()=>resolve([]),600)};}};};
   const dt=new DataTransfer();dt.items.add(new File([],'slow folder'));return dt;
  });
  await page.locator('.xterm-screen').dispatchEvent('drop',{dataTransfer:slow});
  await page.getByRole('button',{name:'Close upload dialog'}).click();
  await page.waitForTimeout(900);assert.equal(ids.size,before,'closing during enumeration starts no hidden upload');
  console.log('PASS: closing during folder discovery cancels it; completed folders are cleared on reopening. '+(publicTest?'Verified through real Cloudflare HTTPS/WSS.':'Verified on local authenticated ttyd.'));
 } finally {
  await browser?.close();
  for(const id of destinations)fs.rmSync(path.join(uploads,'upload-'+id),{recursive:true,force:true});
  for(const id of ids)fs.rmSync(path.join(uploads,'.transfers',id),{recursive:true,force:true});
  const cleanup=`import sys,subprocess;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);c=t.read_config(s);t.stop_process(s,c,'tunnel');t.stop_process(s,c,'ttyd');subprocess.run(['tmux','kill-server'],capture_output=True)`;
  try{execFileSync(python,['-c',cleanup,path.join(root,'scripts'),state],{env});}finally{fs.rmSync(state,{recursive:true,force:true});}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
