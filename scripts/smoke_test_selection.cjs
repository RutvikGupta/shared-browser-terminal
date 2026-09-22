// Optional browser integration test: install Playwright separately, or set PLAYWRIGHT_MODULE.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-select-'));
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
  try {
    execFileSync(python, ['-c', setup, root, state], {env});
    const config=JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8'));
    const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim();
    const split=login.indexOf(':');
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({httpCredentials:{username:login.slice(0,split),password:login.slice(split+1)},permissions:['clipboard-read','clipboard-write'],viewport:{width:1200,height:800}});
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:'+config.port);
    await page.waitForFunction(() => window.term?.buffer.active.getLine(window.term.buffer.active.viewportY)?.translateToString().includes('Copy sample'));
    const location=await page.evaluate(() => {
      const t=window.term, r=t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return {x:r.x,y:r.y,w:r.width/t.cols,h:r.height/t.rows,expected:t.buffer.active.getLine(t.buffer.active.viewportY).translateToString().slice(0,16)};
    });
    const drag=async(reverse=false) => {
      const a={x:location.x+0.1*location.w,y:location.y+0.5*location.h};
      const b={x:location.x+16.1*location.w,y:a.y};
      const start=reverse?b:a,end=reverse?a:b;
      await page.mouse.move(start.x,start.y); await page.mouse.down();
      await page.mouse.move(end.x,end.y,{steps:8}); await page.mouse.up();
    };
    await drag();
    assert.equal(await page.evaluate(()=>window.term.getSelection()),location.expected,'highlight survives release');
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),location.expected,'Command+C copies selected text');
    assert.equal(await page.evaluate(()=>window.term.getSelection()),location.expected,'copy preserves highlight');
    assert(!fs.existsSync(path.join(state,'input.bin')),'selection and copy must not send terminal input');
    await drag(true);
    assert.equal(await page.evaluate(()=>window.term.getSelection()),location.expected,'reverse drag selects the same text');
    await page.keyboard.press('Control+Shift+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),location.expected);
    await page.evaluate(async () => {
      await navigator.clipboard.writeText('stale clipboard');
      Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('clipboard API unavailable'))});
    });
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),location.expected,'native copy fallback works when the Clipboard API is blocked');
    await page.keyboard.press('Control+c');
    for(let i=0;i<50&&!fs.existsSync(path.join(state,'input.bin'));i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(path.join(state,'input.bin')).toString('hex'),'03','Ctrl+C must still reach the program');
    await page.mouse.wheel(0,-500);
    let copying='';
    for(let i=0;i<50;i++) {
      copying=execFileSync('tmux',['display-message','-p','-t','selection-test:0.0','#{pane_in_mode}'],{env,encoding:'utf8'}).trim();
      if(copying==='1')break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(copying,'1','wheel must still enter tmux scrollback');
    assert(await page.getByRole('button',{name:'Upload documents',exact:true}).isVisible());
    execFileSync('tmux',['send-keys','-X','-t','selection-test:0.0','cancel'],{env});
    await page.waitForFunction(()=>window.term.options.theme.cursor !== '#00000000');
    const cursor=await page.evaluate(()=>window.term.options.theme.cursor);
    // Trigger redraws from the synthetic program, through real tmux/ttyd.
    execFileSync('tmux',['send-keys','-t','selection-test:0.0','-l','r'],{env});
    await page.waitForFunction(()=>window.term.options.theme.cursor === '#00000000');
    await page.waitForFunction(expected=>window.term.options.theme.cursor === expected,cursor);
    execFileSync('tmux',['send-keys','-t','selection-test:0.0','-l','r'],{env});
    await page.waitForFunction(()=>window.term.options.theme.cursor === '#00000000');
    await page.keyboard.type('x');
    assert.equal(await page.evaluate(()=>window.term.options.theme.cursor),cursor,'typing restores caret during redraw');
    console.log('PASS: cursor hidden during real tmux output bursts, restored after output settles and immediately on input.');
    console.log('PASS: forward/reverse drag persists; Command+C and Ctrl+Shift+C copy exact text without shell input; Ctrl+C interrupts; wheel scrollback and Upload remain available.');
  } finally {
    if(browser)await browser.close();
    const cleanup=String.raw`
import sys, subprocess
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'scripts'))
import browser_terminal as terminal
state=Path(sys.argv[2]); config=terminal.read_config(state)
terminal.stop_process(state,config,'ttyd')
subprocess.run(['tmux','kill-server'],capture_output=True)
`;
    try {execFileSync(python,['-c',cleanup,root,state],{env});}
    finally {fs.rmSync(state,{recursive:true,force:true});}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
