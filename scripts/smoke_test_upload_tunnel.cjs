// Optional real-tunnel transport check. Only synthetic files are uploaded; no terminal input is sent.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const state=process.argv[2];
if(!state)throw new Error('Pass the managed terminal state directory.');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {execFileSync}=require('node:child_process');
(async()=>{
 const raw=execFileSync('python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;print(t.read_url(Path(sys.argv[2])))",path.join(root,'scripts'),state],{encoding:'utf8'}).trim();
 const login=fs.readFileSync(path.join(state,'login.txt'),'utf8').trim(),i=login.indexOf(':');
 const browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({httpCredentials:{username:login.slice(0,i),password:login.slice(i+1)}});
 try {
 await ctx.route(raw+'/',r=>r.fulfill({contentType:'text/html',body:'<html><body>'+fs.readFileSync(path.join(root,'assets/upload-transport.html'),'utf8')+'</body></html>'}));
 const page=await ctx.newPage();await page.goto(raw+'/');
 const result=await page.evaluate(async()=>{
  const events=[];const Real=WebSocket;
  window.WebSocket=class extends Real {constructor(...args){super(...args);this.addEventListener('close',e=>events.push({code:e.code,reason:e.reason}));}};
  const results=await Promise.all([0,1,2].map(async n=>{
   const bytes=new Uint8Array([150,140,145][n]*1024*1024);bytes.fill(65+n);let progress=0;
   try { const path=await window.sharedTerminalUpload(new File([bytes],'synthetic-'+n+'.bin'),{signal:new AbortController().signal,onProgress:p=>progress=p,onState:()=>{}});return {path,progress,n}; }
   catch(e){return {error:e.message,progress};}
  }));return {results,events};
 });
 for(const entry of result.results){
  if(entry.path){
   try {
    const data=fs.readFileSync(entry.path), expected=Buffer.alloc([150,140,145][entry.n]*1024*1024,65+entry.n);
    entry.valid=crypto.createHash('sha256').update(data).digest('hex')===crypto.createHash('sha256').update(expected).digest('hex');
    entry.bytes=data.length;
   }finally{fs.rmSync(path.dirname(entry.path),{recursive:true});delete entry.path;}
  }
 }
 console.log(JSON.stringify(result));
 assert(result.results.every(entry=>entry.valid&&entry.bytes===entry.progress),'all concurrent uploads must finish with exact content');
 console.log('PASS: public tunnel transferred 150, 140, and 145 MiB concurrently with matching SHA-256 hashes.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
