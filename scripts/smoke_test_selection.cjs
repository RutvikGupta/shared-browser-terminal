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
fixture.write_text("import os,tty,time\nfrom pathlib import Path\ntty.setraw(0)\nos.write(1, ('\\x1b[2J\\x1b[H'+'\\r\\n'.join('Copy sample line %03d alpha beta gamma https://example.test/terminal-link café 你好 élan' % i for i in range(100))).encode())\nwhile True:\n data=os.read(0,1024)\n if data==b'r':\n  for i in range(30):\n   os.write(1,b'\\x1b[?25l\\x1b[1;20H.\\x1b[?25h')\n   time.sleep(0.035)\n with Path(__file__).with_name('input.bin').open('ab') as out: out.write(data)\n")
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
    await page.evaluate(()=>navigator.clipboard.writeText('keep my clipboard'));
    await drag();
    assert.equal(await page.evaluate(()=>window.term.getSelection()),location.expected,'highlight survives release');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'keep my clipboard','drag selection does not copy');
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
    for (const word of ['sample', 'café', '你好', 'élan']) {
      const target=await page.evaluate(word=>{
        const term=window.term, line=term.buffer.active.getLine(term.buffer.active.viewportY);
        for(let column=0;column<term.cols;column++) {
          if(line.translateToString(true,column).startsWith(word))return column;
        }
        throw new Error('Missing test word: '+word);
      },word);
      // The second cell of a wide character must select the same word.
      const clipboardBefore=await page.evaluate(()=>navigator.clipboard.readText());
      await page.mouse.dblclick(location.x+(target+(word==='你好'?1.5:0.5))*location.w,location.y+0.5*location.h);
      assert.equal(await page.evaluate(()=>window.term.getSelection()),word,'double-click selects '+word+' after release');
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),clipboardBefore,'double-click does not copy');
      await page.keyboard.press('Meta+c');
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),word,'double-click selection is copyable');
    }
    // Shift-click extends from the original anchor, including reverse and multiline selections.
    const clickCell=async(column,row=0,shift=false)=>{
      if(shift)await page.keyboard.down('Shift');
      await page.mouse.click(location.x+(column+0.1)*location.w,location.y+(row+0.5)*location.h);
      if(shift)await page.keyboard.up('Shift');
    };
    const shiftClipboard=await page.evaluate(()=>navigator.clipboard.readText());
    const lineText=await page.evaluate(()=>window.term.buffer.active.getLine(window.term.buffer.active.viewportY).translateToString());
    await clickCell(5);
    await clickCell(16,0,true);
    assert.equal(await page.evaluate(()=>window.term.getSelection()),lineText.slice(5,16),'click then Shift-click extends selection');
    await clickCell(20,0,true);
    assert.equal(await page.evaluate(()=>window.term.getSelection()),lineText.slice(5,20),'repeated Shift-click keeps original anchor');
    await clickCell(2,0,true);
    assert.equal(await page.evaluate(()=>window.term.getSelection()),lineText.slice(2,5),'Shift-click can cross the anchor');
    await drag(true);
    await clickCell(22,0,true);
    assert.equal(await page.evaluate(()=>window.term.getSelection()),lineText.slice(16,22),'reverse drag retains its original anchor');
    await clickCell(5);
    await clickCell(8,1,true);
    const multiline=await page.evaluate(()=>{
      const t=window.term,b=t.buffer.active;
      return b.getLine(b.viewportY).translateToString(true,5)+'\n'+b.getLine(b.viewportY+1).translateToString(false,0,8);
    });
    assert.equal(await page.evaluate(()=>window.term.getSelection()),multiline,'Shift-click spans hard line breaks');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),shiftClipboard,'Shift-click never copies automatically');
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),multiline,'Shift-click selection copies explicitly');
    assert(!fs.existsSync(path.join(state,'input.bin')),'Shift-click sends no program input');
    console.log('PASS: Shift-click extends and reverses selection from its anchor without copying or terminal input.');
    // Command-click adds separate full lines; a second click removes one.
    await clickCell(5);
    const beforeMulti=await page.evaluate(()=>navigator.clipboard.readText());
    const commandClick=async(row)=>{
      await page.keyboard.down('Meta');
      await clickCell(5,row);
      await page.keyboard.up('Meta');
    };
    await commandClick(2); await commandClick(0);
    assert.equal(await page.locator('.sbt-selected-line').count(),2,'separate lines remain highlighted');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),beforeMulti,'Command-click never copies automatically');
    const multiExpected=await page.evaluate(()=>{
      const b=window.term.buffer.active;
      return [0,2].map(row=>b.getLine(b.viewportY+row).translateToString(true)).join('\n');
    });
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),multiExpected,'copies selected lines in screen order without the skipped line');
    await commandClick(2);
    assert.equal(await page.locator('.sbt-selected-line').count(),1,'Command-click toggles a line off');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.sbt-selected-line').count(),0,'Escape clears multiline selection');
    assert(!fs.existsSync(path.join(state,'input.bin')),'Command-click selection and Escape do not send input');
    await drag(); await commandClick(2);
    assert.equal(await page.locator('.sbt-selected-line').count(),2,'Command-click preserves an existing selected line');
    await clickCell(5);
    assert.equal(await page.locator('.sbt-selected-line').count(),0,'ordinary click starts a fresh selection');
    console.log('PASS: Command-click toggles separate lines, copies in display order, preserves clipboard until explicit copy, and clears on ordinary click or Escape.');
    const beforeLine=await page.evaluate(()=>navigator.clipboard.readText());
    await page.mouse.click(location.x+8.5*location.w,location.y+0.5*location.h,{clickCount:3});
    const wholeLine=await page.evaluate(()=>window.term.buffer.active.getLine(window.term.buffer.active.viewportY).translateToString(true));
    assert.equal(await page.evaluate(()=>window.term.getSelection()),wholeLine,'triple-click selects the whole line');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),beforeLine,'triple-click does not copy');
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),wholeLine,'explicit copy still copies a whole line');
    assert(!fs.existsSync(path.join(state,'input.bin')),'double-click and copy must not send terminal input');
    console.log('PASS: double-click selects words, including wide and combining characters, and Command+C copies them.');
    // External navigation is fulfilled locally: no real website is contacted.
    await context.route('https://example.test/**', route=>route.fulfill({body:'Terminal link test'}));
    await page.mouse.move(location.x+48*location.w,location.y+0.5*location.h);
    await page.mouse.click(location.x+48*location.w,location.y+0.5*location.h);
    await page.waitForTimeout(100);
    assert.equal(context.pages().length,1,'ordinary click must not open links');
    assert(!fs.existsSync(path.join(state,'input.bin')),'ordinary click remains browser selection');
    await page.keyboard.down('Meta');
    const opened=context.waitForEvent('page',{timeout:5000});
    await page.mouse.click(location.x+48*location.w,location.y+0.5*location.h);
    await page.keyboard.up('Meta');
    const linked=await opened;
    await linked.waitForURL('https://example.test/terminal-link');
    assert.equal(await linked.evaluate(()=>window.opener),null,'opened link cannot control terminal tab');
    await linked.close();
    await page.bringToFront();
    assert(!fs.existsSync(path.join(state,'input.bin')),'Command-click must not send terminal input');
    await page.evaluate(()=>window.term.focus());
    console.log('PASS: Command-click opens the URL in a separate tab without terminal input.');
    await page.keyboard.press('Control+c');
    for(let i=0;i<50&&!fs.existsSync(path.join(state,'input.bin'));i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(path.join(state,'input.bin')).toString('hex'),'03','Ctrl+C must still reach the program');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Enter');
    for(let i=0;i<50&&fs.statSync(path.join(state,'input.bin')).size<4;i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(fs.readFileSync(path.join(state,'input.bin')).toString('hex'),'031b0d0d','Shift+Enter sends one Alt+Enter through tmux; ordinary Enter stays CR');
    // Observe our capture handler before xterm handles ignored events.
    const ignored=await page.evaluate(() => {
      const results=[];
      const observe=event=>{results.push(event.defaultPrevented);event.stopImmediatePropagation();};
      document.addEventListener('keydown',observe,true);
      for(const extra of [{altKey:true},{ctrlKey:true},{metaKey:true},{isComposing:true},{keyCode:229}]) {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true,...extra}));
      }
      document.removeEventListener('keydown',observe,true);
      return results;
    });
    assert.deepEqual(ignored,[false,false,false,false,false],'other modifiers and IME confirmation bypass the mapping');
    await page.getByRole('button',{name:'Upload documents',exact:true}).focus();
    const outside=await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true})));
    assert(outside,'Shift+Enter outside the terminal is not intercepted');
    await page.evaluate(()=>window.term.focus());
    console.log('PASS: Shift+Enter newline alias survives tmux; Enter, other modifiers, IME, and non-terminal controls are preserved.');
    await page.mouse.wheel(0,-500);
    let copying='';
    for(let i=0;i<50;i++) {
      copying=execFileSync('tmux',['display-message','-p','-t','selection-test:0.0','#{pane_in_mode}'],{env,encoding:'utf8'}).trim();
      if(copying==='1')break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(copying,'1','wheel must still enter tmux scrollback');
    assert(await page.getByRole('button',{name:'Upload documents',exact:true}).isVisible());
    const rawBeforeScroll=fs.readFileSync(path.join(state,'input.bin'));
    const scrollbar=page.getByRole('scrollbar',{name:'Terminal history'});
    await scrollbar.waitFor();
    await page.waitForFunction(()=>Number(document.querySelector('#sbt-scrollbar').getAttribute('aria-valuemax'))>0);
    const bounds=await scrollbar.boundingBox();
    await page.mouse.click(bounds.x+bounds.width/2,bounds.y+4);
    await page.waitForFunction(()=>Number(document.querySelector('#sbt-scrollbar').getAttribute('aria-valuenow'))<5);
    assert.equal(execFileSync('tmux',['display-message','-p','-t','selection-test:0.0','#{pane_in_mode}'],{env,encoding:'utf8'}).trim(),'1','scrollbar accesses tmux history');
    // Drag down, then jump all the way to live output.
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+8);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height*0.6,{steps:8});await page.mouse.up();
    await page.waitForFunction(()=>Number(document.querySelector('#sbt-scrollbar').getAttribute('aria-valuenow'))>5);
    await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
    for(let i=0;i<100;i++){
      if(execFileSync('tmux',['display-message','-p','-t','selection-test:0.0','#{pane_in_mode}'],{env,encoding:'utf8'}).trim()==='0')break;
      await page.waitForTimeout(20);
    }
    assert.equal(execFileSync('tmux',['display-message','-p','-t','selection-test:0.0','#{pane_in_mode}'],{env,encoding:'utf8'}).trim(),'0','bottom button leaves copy mode');
    await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
    assert.deepEqual(fs.readFileSync(path.join(state,'input.bin')),rawBeforeScroll,'scroll controls never send program input, even when already at bottom');
    await page.screenshot({path:path.join(os.tmpdir(),'sbt-scroll-controls.png')});
    console.log('PASS: visible scrollbar clicks/drags tmux history; bottom button returns to live output without sending input.');

    // Sample through real redraws and then idle, without any keyboard input.
    await page.evaluate(() => {
      window.cursorSamples=[];
      window.cursorSampler=setInterval(()=>window.cursorSamples.push(window.term.options.theme.cursor),10);
    });
    const cursor=await page.evaluate(()=>window.term.options.theme.cursor);
    assert(cursor && cursor !== '#00000000','caret starts with a visible color');
    execFileSync('tmux',['send-keys','-t','selection-test:0.0','-l','r'],{env});
    await page.waitForTimeout(1600);
    const samples=await page.evaluate(() => {
      clearInterval(window.cursorSampler);
      return window.cursorSamples;
    });
    assert(samples.length>30,'observed output and idle periods');
    assert(samples.every(color=>color===cursor),'browser must not hide the caret during redraws or idle');
    assert.equal(await page.evaluate(()=>window.term.options.cursorBlink),false,'steady cursor remains enabled');
    console.log('PASS: caret color remains visible through real tmux redraws and idle without typing.');
    // Check selection across a soft wrap using the public terminal buffer API.
    await page.evaluate(()=>new Promise(resolve=>window.term.write('\x1b[2J\x1b[H'+' '.repeat(window.term.cols-4)+'wrappedword',resolve)));
    const wrapped=await page.evaluate(()=>{
      const t=window.term,r=t.element.querySelector('.xterm-screen').getBoundingClientRect();
      return {x:r.x+r.width/t.cols*1.5,y:r.y+r.height/t.rows*1.5};
    });
    await page.mouse.dblclick(wrapped.x,wrapped.y);
    assert.equal(await page.evaluate(()=>window.term.getSelection()),'wrappedword','word selection spans a soft line wrap');
    const beforeWrapped=await page.evaluate(()=>navigator.clipboard.readText());
    await page.mouse.click(wrapped.x,wrapped.y,{clickCount:3});
    const wrappedExpected=await page.evaluate(()=>' '.repeat(window.term.cols-4)+'wrappedword');
    assert.equal(await page.evaluate(()=>window.term.getSelection()),wrappedExpected,'triple-click includes the entire wrapped logical line');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),beforeWrapped,'wrapped line selection does not copy');
    await page.mouse.click(wrapped.x,wrapped.y);
    await page.keyboard.down('Meta');await page.mouse.click(wrapped.x,wrapped.y);await page.keyboard.up('Meta');
    assert.equal(await page.locator('.sbt-selected-line').count(),1,'wrapped logical line is one additive selection');
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),wrappedExpected,'additive selection copies a soft wrap without extra newline');
    await page.evaluate(()=>new Promise(resolve=>window.term.write('\x1b[2J\x1b[Hchanged output',resolve)));
    await page.waitForFunction(()=>!document.querySelector('#sbt-multiple-selection'));
    console.log('PASS: additive selection handles soft wraps and clears when selected output changes.');
    console.log('PASS: triple-click selects full logical lines; drag, double-click, and triple-click leave the clipboard unchanged until explicit copy.');


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
