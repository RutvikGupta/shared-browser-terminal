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
    const files=[{name:"report ' résumé $(echo test).txt",text:'Synthetic first document.\n'},{name:'second report.txt',text:'Synthetic second document.\n'}];
    await context.addInitScript(files=>{
      window.showOpenFilePicker=async()=>{
        if(!navigator.userActivation.isActive)throw new Error('No file picker user activation');
        return files.map(file=>({kind:'file',name:file.name,getFile:async()=>new File([file.text],file.name,{type:'text/plain'})}));
      };
    },files);
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:'+config.port);
    await page.waitForFunction(()=>window.term?.buffer.active.getLine(window.term.buffer.active.viewportY)?.translateToString().includes('Copy sample'));
    // Keep the upload receipts so assertions use server-reported actual paths.
    await page.evaluate(()=>{
      window.uploadReceipts=[];
      window.addEventListener('message',e=>{
        if(e.origin===location.origin&&e.source===document.querySelector('#sbt-dialog iframe')?.contentWindow&&e.data?.type==='sbt-upload-complete')window.uploadReceipts.push(e.data.paths);
      },true);
      window.term.paste('existing draft');
    });
    const upload=async(insert=true)=>{
      await page.getByRole('button',{name:'Upload documents',exact:true}).click();
      if(!insert)await page.locator('#sbt-insert-paths').uncheck();
      const frame=page.frameLocator('iframe[title="Document upload terminal"]');
      await frame.getByRole('button',{name:'Choose files',exact:true}).click({timeout:15000});
    };
    await upload();
    await page.waitForFunction(()=>window.uploadReceipts.length===1,{},{timeout:20000});
    const paths=await page.evaluate(()=>window.uploadReceipts[0]);
    paths.forEach(p=>receivedDirs.add(path.dirname(p)));
    assert.equal(paths.length,2);
    for(const file of files){const target=paths.find(p=>path.basename(p)===file.name);assert(target);assert.equal(fs.readFileSync(target,'utf8'),file.text);}
    await page.locator('#sbt-dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.term.element.contains(document.activeElement));
    const expected='existing draft '+paths.map(p=>"'"+p.replaceAll("'","'\\''")+"'").join(' ')+' ';
    const input=path.join(state,'input.bin');
    for(let i=0;i<100 && (!fs.existsSync(input)||fs.readFileSync(input,'utf8')!==expected);i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(input,'utf8'),expected,'exact quoted paths append without clearing draft or sending Enter');
    const parsed=JSON.parse(execFileSync(python,['-c','import sys,shlex,json; print(json.dumps(shlex.split(sys.stdin.read())))'],{input:expected,encoding:'utf8'}));
    assert.deepEqual(parsed,['existing','draft',...paths],'shell quoting preserves filenames as literal arguments');
    // Uploading the same names again creates distinct host paths; opt-out sends no input.
    await upload(false);
    await page.waitForFunction(()=>window.uploadReceipts.length===2,{},{timeout:20000});
    const second=await page.evaluate(()=>window.uploadReceipts[1]);
    second.forEach(p=>receivedDirs.add(path.dirname(p)));
    assert.notEqual(path.dirname(second[0]),path.dirname(paths[0]));
    assert.equal(fs.readFileSync(input,'utf8'),expected);
    await page.getByRole('button',{name:'Close upload dialog'}).click();
    // Canceled picker must not paste partial paths or emit a completion receipt.
    await page.getByRole('button',{name:'Upload documents',exact:true}).click();
    await page.frameLocator('iframe').getByRole('button',{name:'Choose files',exact:true}).waitFor();
    const frame=page.frames().find(frame=>frame.url().includes('arg=upload'));
    await frame.evaluate(()=>{window.showOpenFilePicker=async()=>{throw new DOMException('Canceled','AbortError');};});
    await page.frameLocator('iframe').getByRole('button',{name:'Choose files',exact:true}).click();
    await frame.waitForFunction(()=>{
      const t=window.term;
      for(let i=0;i<t.buffer.active.length;i++)if(t.buffer.active.getLine(i)?.translateToString().includes('No completed upload paths'))return true;
      return false;
    });
    assert.equal(await page.evaluate(()=>window.uploadReceipts.length),2);
    assert.equal(fs.readFileSync(input,'utf8'),expected);
    console.log('PASS: multiple actual uploads, Unicode/spaces/quotes, exact saved bytes, existing draft preserved, no Enter, opt-out, unique duplicate destinations, and cancellation.');
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
