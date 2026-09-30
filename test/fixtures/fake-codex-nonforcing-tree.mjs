#!/usr/bin/env node
// Disposable fixture only; never contacts a service or loads user configuration.
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import readline from 'node:readline';
const childCode="process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)";
const child=spawn(process.execPath,['-e',childCode],{detached:true,stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>writeFileSync(process.env.COGATE_TEST_TREE_CHILD,JSON.stringify({pid:child.pid})));
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize')process.stdout.write(JSON.stringify({id:message.id,result:{userAgent:'isolated-tree',platformFamily:'unix',platformOs:'test'}})+'\n');
 else if(message.method==='model/list')process.stdout.write(JSON.stringify({id:message.id,result:{data:[]}})+'\n');
});
lines.on('close',()=>process.exit(0));
