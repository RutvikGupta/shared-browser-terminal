// Isolated full-screen application fixture; no live agent input or conversation data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),state=fs.mkdtempSync(path.join(os.tmpdir(),'sbt-bottom-'));
const env={...process.env,TMUX_TMPDIR:state};delete env.TMUX;
const python=process.env.PYTHON || 'python3';
fs.writeFileSync(path.join(state,'fixture.c'),String.raw`
#include <stdio.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>
int main(void) {
  struct termios settings; tcgetattr(0,&settings); cfmakeraw(&settings); tcsetattr(0,TCSANOW,&settings);
  printf("\033[?1049h\033[?1000h\033[?1006h\033[2J\033[HOLD TRANSCRIPT\r\ndraft remains"); fflush(stdout);
  char buffer[4096]={0}; size_t used=0; ssize_t count;
  FILE *log=fopen("input.bin","ab");
  while((count=read(0,buffer+used,sizeof(buffer)-used-1))>0) {
    fwrite(buffer+used,1,count,log); fflush(log); used+=count; buffer[used]=0;
    if(strstr(buffer,"\033[1;5F")) { printf("\033[2J\033[HLATEST TRANSCRIPT\r\ndraft remains"); fflush(stdout); used=0; }
    if(used>2048)used=0;
  }
  return 0;
}
`);
const setup=String.raw`
import sys,socket
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'scripts'))
import browser_terminal as t
s=Path(sys.argv[2])
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
c={'session':'bottom-test','port':port,'font_size':14,'cwd':str(s)}
t.prepare_state(s);t.save_config(s,c);t.ensure_credentials(s)
t.run('tmux','-f','/dev/null','new-session','-d','-s',c['session'],'-c',str(s),str(s/'codex'))
t.restart_ttyd(s,c)
`;
(async()=>{
 let browser;
 try{
  execFileSync('cc',[path.join(state,'fixture.c'),'-o',path.join(state,'codex')]);
  fs.copyFileSync(path.join(state,'codex'),path.join(state,'claude'));
  execFileSync(python,['-c',setup,root,state],{env});
  const config=JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8'));
  const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim(),colon=login.indexOf(':');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({httpCredentials:{username:login.slice(0,colon),password:login.slice(colon+1)}});
  const page=await context.newPage();
  await page.addInitScript(()=>{
    const repeat=window.setInterval;
    window.holdScrollPoll=false;
    window.setInterval=(callback,delay,...args)=>repeat(()=>{
      if(delay!==750 || !window.holdScrollPoll)callback(...args);
    },delay);
  });
  await page.goto('http://127.0.0.1:'+config.port);
  await page.waitForFunction(()=>window.term && !document.querySelector('#sbt-bottom').disabled);
  await page.waitForFunction(()=>window.term.buffer.active.getLine(0)?.translateToString().includes('OLD TRANSCRIPT'));
  await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
  await page.waitForFunction(()=>window.term.buffer.active.getLine(0)?.translateToString().includes('LATEST TRANSCRIPT'),{},{timeout:4000});
  assert.equal(fs.readFileSync(path.join(state,'input.bin'),'utf8'),'\x1b[1;5F','only the scroll shortcut reaches the app');
  assert(await page.evaluate(()=>window.term.buffer.active.getLine(1).translateToString().includes('draft remains')));
  execFileSync('tmux',['copy-mode','-t','=bottom-test:'],{env});
  await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#sbt-bottom').disabled);
  assert.equal(execFileSync('tmux',['display-message','-p','-t','=bottom-test:','#{pane_in_mode}'],{env,encoding:'utf8'}).trim(),'0');
  assert.equal(fs.readFileSync(path.join(state,'input.bin'),'utf8'),'\x1b[1;5F\x1b[1;5F');
  await page.evaluate(()=>window.sharedTerminalPrepareInput());
  assert.equal(fs.readFileSync(path.join(state,'input.bin'),'utf8'),'\x1b[1;5F\x1b[1;5F','upload preparation sends no application shortcut');
  await page.evaluate(()=>{window.holdScrollPoll=true;});
  execFileSync('tmux',['new-window','-t','=bottom-test:','-c',state,path.join(state,'claude')],{env});
  await page.waitForFunction(()=>window.term.buffer.active.getLine(0)?.translateToString().includes('OLD TRANSCRIPT'));
  await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
  await page.waitForFunction(()=>window.term.buffer.active.getLine(0)?.translateToString().includes('LATEST TRANSCRIPT'));
  assert.equal(fs.readFileSync(path.join(state,'input.bin'),'utf8'),'\x1b[1;5F\x1b[1;5F\x1b[1;5F');
  console.log('PASS: first click follows a changed pane into Claude Code even before polling refreshes; upload input preparation sends no shortcut.');
  console.log('PASS: bottom button reaches latest output in a mouse-enabled alternate-screen Codex fixture, including from tmux copy mode; only Ctrl+End is sent.');
 }finally{
  if(browser)await browser.close();
  try{execFileSync(python,['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);t.stop_process(s,t.read_config(s),'ttyd')",path.join(root,'scripts'),state],{env});}finally{
   execFileSync('tmux',['kill-server'],{env});fs.rmSync(state,{recursive:true,force:true});
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
