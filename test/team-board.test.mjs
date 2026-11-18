import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChatService} from '../src/chat-service.mjs';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
import {TeamBoard} from '../src/team-board.mjs';
const encrypt=s=>Buffer.from(s).map(b=>b^42),decrypt=b=>Buffer.from(b).map(b=>b^42).toString();

async function setup(t){
 const directory=await mkdtemp(join(tmpdir(),'gratis-team-')),files=new WorkspaceFiles(directory);
 const service=new ChatService({dataDir:directory,backend:async function*(){yield 'ok';}});await service.init();
 await service.createBot({name:'Writer',instructions:'Writes reports',promptMode:'manual'});
 const board=await new TeamBoard({directory,encrypt,decrypt,service,files}).init();
 t.after(async()=>{await board.close();await service.close();await rm(directory,{recursive:true,force:true});});
 const [chief,writer]=service.state.bots.map(b=>b.id);
 return{directory,service,files,board,chief,writer};
}

test('chief sees the directory; other teammates cannot',async t=>{
 const f=await setup(t);
 const rows=await f.board.directoryFor(f.chief);
 assert.equal(rows.length,2);assert.equal(rows[0].chief,true);
 await assert.rejects(f.board.directoryFor(f.writer),/chief/);
 const one=await f.board.directoryFor(f.chief,f.writer);assert.deepEqual(one[0].files,[]);
});

test('assignment is chief-only and teammates only see their own tasks',async t=>{
 const f=await setup(t);
 await assert.rejects(f.board.create(f.writer,{title:'x',assigneeId:f.chief}),/chief/);
 const task=await f.board.create(f.chief,{title:'Draft report',assigneeId:f.writer});
 await f.board.create(f.chief,{title:'Chief only'});
 assert.equal(f.board.list(f.writer).length,1);assert.equal(f.board.list(f.chief).length,2);
 await assert.rejects(f.board.update(f.chief+'x',{id:task.id,status:'done'}));
 await assert.rejects(f.board.attach(f.chief,{id:task.id,summary:'not mine'}),/not yours/);
});

test('chief verifies and reads a recorded output, and catches a missing or changed file',async t=>{
 const f=await setup(t);
 const task=await f.board.create(f.chief,{title:'Report',assigneeId:f.writer});
 await f.files.write(f.writer,'report.md','# Findings');
 const done=await f.board.attach(f.writer,{id:task.id,path:'report.md'});
 await f.board.update(f.writer,{id:task.id,status:'done'});
 assert.equal(done.outputs[0].bytes,10);
 const v=await f.board.verify(f.chief,task.id);assert.equal(v.confirmed,true);assert.equal(v.outputs[0].state,'unchanged');
 const r=await f.board.read(f.chief,{id:task.id});assert.equal(r.text,'# Findings');assert.equal(r.untrustedContent,true);
 await unlink(await f.files.target(f.writer,'report.md'));
 const gone=await f.board.verify(f.chief,task.id);assert.equal(gone.confirmed,false);assert.equal(gone.outputs[0].state,'missing');
 await assert.rejects(f.board.verify(f.writer,task.id),/chief/);
 await assert.rejects(f.board.read(f.writer,{id:task.id}),/chief/);
});

test('a task marked done with no output is not confirmed, and attaching needs a real file',async t=>{
 const f=await setup(t);
 const task=await f.board.create(f.chief,{title:'Report',assigneeId:f.writer});
 await f.board.update(f.writer,{id:task.id,status:'done'});
 assert.equal((await f.board.verify(f.chief,task.id)).confirmed,false);
 await assert.rejects(f.board.attach(f.writer,{id:task.id,path:'ghost.md'}));
 await assert.rejects(f.board.attach(f.writer,{id:task.id,path:'../../etc/passwd'}));
});

test('the board is encrypted at rest and survives restart',async t=>{
 const f=await setup(t);
 await f.board.create(f.chief,{title:'Secret launch plan',assigneeId:f.writer});
 assert.equal((await readFile(join(f.directory,'teamboard.secure'))).includes(Buffer.from('Secret launch plan')),false);
 const again=await new TeamBoard({directory:f.directory,encrypt,decrypt,service:f.service,files:f.files}).init();
 assert.equal(again.list(f.chief)[0].title,'Secret launch plan');
});
