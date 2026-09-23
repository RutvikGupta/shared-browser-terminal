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
    const context=await browser.newContext({httpCredentials:{username:login.slice(0,split),password:login.slice(split+1)},viewport:{width:1200,height:800}});
    const files=[
      {name:"report ' résumé $(echo test).bin",buffer:Buffer.alloc(800000,0xff),mimeType:'application/octet-stream'},
      {name:'second report.bin',buffer:Buffer.from(Array.from({length:600000},(_,i)=>i%256)),mimeType:'application/octet-stream'},
      {name:'third.bin',buffer:Buffer.alloc(400000,33),mimeType:'application/octet-stream'},
      {name:'empty.txt',buffer:Buffer.alloc(0),mimeType:'text/plain'},
      {name:'last.txt',buffer:Buffer.from('final document'),mimeType:'text/plain'}
    ];
    await context.addInitScript(()=>{
      // Slow only reads of synthetic selected files so overlapping states are observable.
      const slice=File.prototype.slice;
      File.prototype.slice=function(...args){
        const blob=slice.apply(this,args), read=blob.arrayBuffer.bind(blob);
        blob.arrayBuffer=async()=>{await new Promise(resolve=>setTimeout(resolve,40));return read();};
        return blob;
      };
    });
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:'+config.port);
    await page.waitForFunction(()=>window.term?.buffer.active.getLine(window.term.buffer.active.viewportY)?.translateToString().includes('Copy sample'));
    await page.evaluate(()=>{
      window.term.paste('existing draft');
      window.maxUploads=0;window.sawPartial=false;window.rowCounts=[];
      window.sampler=setInterval(()=>{
        const rows=[...document.querySelectorAll('.sbt-file')];
        window.maxUploads=Math.max(window.maxUploads,rows.filter(row=>row.dataset.state==='uploading').length);
        window.sawPartial ||= rows.some(row=>{const p=row.querySelector('progress');return p.value>0&&p.value<1;});
        window.rowCounts.push(rows.length);
      },10);
    });
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    assert(await page.locator('#sbt-file-input').getAttribute('multiple')!==null);
    await page.locator('#sbt-file-input').setInputFiles(files);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file[data-state="complete"]').length===5,{},{timeout:30000});
    const paths=await page.locator('.sbt-file code').allTextContents();
    paths.forEach(p=>receivedDirs.add(path.dirname(p)));
    for(let i=0;i<files.length;i++)assert.deepEqual(fs.readFileSync(paths[i]),files[i].buffer,'exact binary content');
    assert(await page.locator('#sbt-dialog').isVisible(),'completed list remains visible');
    assert.equal(await page.locator('.sbt-file').count(),5,'all selected files retain a row');
    const observation=await page.evaluate(()=>({max:window.maxUploads,partial:window.sawPartial}));
    assert(observation.max>=2&&observation.max<=3,'transfers overlap within the configured limit');
    assert(observation.partial,'receiver-acknowledged intermediate progress is displayed');
    const expected='existing draft '+paths.map(p=>"'"+p.replaceAll("'","'\\''")+"'").join(' ')+' ';
    const input=path.join(state,'input.bin');
    for(let i=0;i<100&&(!fs.existsSync(input)||fs.readFileSync(input,'utf8')!==expected);i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(input,'utf8'),expected,'all paths insert once, without clearing draft or Enter');
    await page.locator('#sbt-insert-paths').uncheck();
    // An invalid filename fails only its own row; queued files continue.
    const more=[{name:'bad\nname.txt',buffer:Buffer.from('bad'),mimeType:'text/plain'},files[4]];
    await page.locator('#sbt-file-input').setInputFiles(more);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file[data-state="failed"]').length===1&&document.querySelectorAll('.sbt-file[data-state="complete"]').length===6);
    const duplicate=await page.locator('.sbt-file code').nth(6).textContent();
    receivedDirs.add(path.dirname(duplicate));assert.notEqual(duplicate,paths[4]);
    assert.equal(fs.readFileSync(input,'utf8'),expected,'opt-out sends no extra input');
    // Keep the persistent completed rows while a new file is canceled and retried.
    await page.locator('#sbt-concurrency').selectOption('1');
    await page.locator('#sbt-file-input').setInputFiles([files[0]]);
    const canceled=page.locator('.sbt-file').nth(7);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[7].dataset.state==='uploading');
    await canceled.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[7].dataset.state==='canceled');
    assert.equal(await page.locator('.sbt-file').count(),8);
    await canceled.getByRole('button',{name:'Retry',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[7].dataset.state==='complete',{},{timeout:30000});
    const retried=await canceled.locator('code').textContent();receivedDirs.add(path.dirname(retried));
    assert.deepEqual(fs.readFileSync(retried),files[0].buffer);
    assert.equal(fs.readFileSync(input,'utf8'),expected);
    await page.getByRole('button',{name:'Close upload dialog'}).click();
    await page.waitForFunction(()=>window.term.element.contains(document.activeElement));
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    assert.equal(await page.locator('.sbt-file').count(),8,'reopening preserves all progress rows');
    // A receiver that accepts a file but receives no bytes times out visibly;
    // it is not silently restarted, and Retry uses a fresh connection.
    await page.clock.install();
    await page.evaluate(()=>{
      window.normalSlice=File.prototype.slice;
      File.prototype.slice=function(...args){
        const blob=window.normalSlice.apply(this,args);
        if(this.name==='stalled.bin')blob.arrayBuffer=()=>new Promise(()=>{});
        return blob;
      };
    });
    await page.locator('#sbt-file-input').setInputFiles([{name:'stalled.bin',buffer:Buffer.from('recover me'),mimeType:'application/octet-stream'}]);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[8].dataset.state==='uploading');
    await page.clock.fastForward(90001);
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[8].dataset.state==='failed');
    assert.match(await page.locator('.sbt-file').nth(8).textContent(),/timed out/);
    await page.evaluate(()=>{File.prototype.slice=window.normalSlice;});
    await page.locator('.sbt-file').nth(8).getByRole('button',{name:'Retry',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sbt-file')[8].dataset.state==='complete');
    const recovered=await page.locator('.sbt-file').nth(8).locator('code').textContent();
    receivedDirs.add(path.dirname(recovered));assert.equal(fs.readFileSync(recovered,'utf8'),'recover me');
    assert.equal(fs.readFileSync(input,'utf8'),expected);
    await page.screenshot({path:path.join(os.tmpdir(),'sbt-upload-progress.png')});
    console.log('PASS: concurrent binary uploads with acknowledged intermediate progress; persistent per-file rows; empty/Unicode/duplicate names; exact path insertion; opt-out; independent failure; cancel/retry and retained history.');
  } finally {
    if(browser)await browser.close();
    for(const folder of receivedDirs)fs.rmSync(folder,{recursive:true,force:true});
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
