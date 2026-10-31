import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { Communicator } from "./communicator";
import { startCommunicatingSession } from "./sessions";
import { childEnvironment } from "./child-env";
import { randomUUID } from "node:crypto";

test("Claude launch variants and Command Code reserve unique identities before spawn without tokens in argv", async () => {
 const db=new Database(":memory:");applyDatabaseSchema(db);const comm=new Communicator(db,{isLive:async()=>true});const seen:string[]=[];
 for(const scenario of [{provider:"claude",remoteControl:1},{provider:"claude",remoteControl:0,resumeId:"resume"},{provider:"claude",remoteControl:1,claudeUrl:"https://claude.ai/chat/test"},{provider:"command-code",remoteControl:0}] as const){
  const name="demo"+seen.length;
  const result=await startCommunicatingSession({screen:"cs-"+name,name,projectPath:"/srv/demo",...scenario,command:args=>"agent "+args.join(" ")},{database:db,communicator:comm,hasHolder:async()=>false,uuid:randomUUID,now:()=>1,configure:async()=>["--config","credential-free"],spawn:async(screen,cmd,{env}={})=>{
   const token=env!.CS_COMMUNICATOR_TOKEN!;seen.push(token);expect(cmd).not.toContain(token);
   const identity=await comm.identity(token,false);expect(identity.session_id).toBe("m:"+screen);
   expect(childEnvironment(env,{CS_ADMIN_PASSWORD_FILE:"secret"})).toMatchObject({CS_COMMUNICATOR_TOKEN:token});
   return {code:0,out:"",err:""};
  }});
  expect(result).toEqual({ok:true});
 }
 expect(new Set(seen).size).toBe(4);db.close();
});
test("spawn failure revokes its capability and restores a previous row without deleting archive",async()=>{
 const db=new Database(":memory:");applyDatabaseSchema(db);const comm=new Communicator(db,{isLive:async()=>true});const old=randomUUID();
 db.query("INSERT INTO launches(screen,name,project_path,created_at,provider,launch_id) VALUES('cs-demo','demo','/srv/demo',1,'claude',?)").run(old);
 db.query("INSERT INTO archive(name,provider,ended_at) VALUES('demo','claude',1)").run();let token="";
 const result=await startCommunicatingSession({screen:"cs-demo",name:"demo",projectPath:"/srv/demo",provider:"claude",remoteControl:1,resumeArchiveId:1,command:()=>"agent"},{database:db,communicator:comm,hasHolder:async()=>false,uuid:randomUUID,now:()=>2,configure:async()=>[],spawn:async(_s,_c,{env}={})=>{token=env!.CS_COMMUNICATOR_TOKEN!;return{code:1,out:"",err:"failed "+token};}});
 expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain(token);
 expect(db.query("SELECT launch_id FROM launches WHERE screen='cs-demo'").get()).toEqual({launch_id:old});
 expect(db.query("SELECT COUNT(*) AS n FROM archive").get()).toEqual({n:1});
 await expect(comm.identity(token,false)).rejects.toThrow();db.close();
});
test("configuration failure leaves launch and archive untouched and does not spawn", async () => {
 const db=new Database(":memory:");applyDatabaseSchema(db);const comm=new Communicator(db,{isLive:async()=>true});let spawned=false;
 const result=await startCommunicatingSession({screen:"cs-new",name:"new",projectPath:"/srv/demo",provider:"command-code",remoteControl:0,command:()=>"agent"},{database:db,communicator:comm,hasHolder:async()=>false,uuid:randomUUID,now:()=>1,configure:async()=>{throw new Error("Repair MCP config");},spawn:async()=>{spawned=true;return{code:0,out:"",err:""};}});
 expect(result).toEqual({ok:false,error:"Repair MCP config"});expect(spawned).toBe(false);
 expect(db.query("SELECT COUNT(*) AS n FROM launches").get()).toEqual({n:0});expect(db.query("SELECT COUNT(*) AS n FROM communicator_credentials").get()).toEqual({n:0});db.close();
});
test("a delayed second launch cannot replace a session that became live during configuration", async () => {
 const database=new Database(":memory:");applyDatabaseSchema(database);const comm=new Communicator(database,{isLive:async()=>true});
 let release!:()=>void;const configured=new Promise<void>(resolve=>{release=resolve;});let live=false;let spawns=0;let token="";
 const options={screen:"cs-race",name:"race",projectPath:"/srv/demo",provider:"claude" as const,remoteControl:1,command:()=>"agent"};
 const runtime={database,communicator:comm,hasHolder:async()=>live,uuid:randomUUID,now:()=>1,configure:async()=>[],spawn:async(_s:string,_c:string,{env}: {env?:Record<string,string>}={})=>{spawns++;live=true;token=env!.CS_COMMUNICATOR_TOKEN!;return{code:0,out:"",err:""};}};
 const delayed=startCommunicatingSession(options,{...runtime,configure:async()=>{await configured;return[];}});
 expect(await startCommunicatingSession(options,runtime)).toEqual({ok:true});const identity=await comm.identity(token,false);const originalToken=token;
 release();expect((await delayed).ok).toBe(false);expect(spawns).toBe(1);
 expect(await comm.identity(originalToken,false)).toEqual(identity);database.close();
});
test("ownership is rechecked after an awaited holder lookup before a new credential is minted", async () => {
 const database=new Database(":memory:");applyDatabaseSchema(database);const comm=new Communicator(database,{isLive:async()=>true});
 let release!:()=>void;let entered!:()=>void;const checking=new Promise<void>(resolve=>{entered=resolve;});const checked=new Promise<void>(resolve=>{release=resolve;});let token="";let spawns=0;
 const options={screen:"cs-check-race",name:"race",projectPath:"/srv/demo",provider:"claude" as const,remoteControl:1,command:()=>"agent"};
 const runtime={database,communicator:comm,uuid:randomUUID,now:()=>1,hasHolder:async()=>false,configure:async()=>[],spawn:async(_s:string,_c:string,{env}:{env?:Record<string,string>}={})=>{spawns++;token=env!.CS_COMMUNICATOR_TOKEN!;return{code:0,out:"",err:""};}};
 const delayed=startCommunicatingSession(options,{...runtime,hasHolder:async()=>{entered();await checked;return false;}});
 await checking;expect(await startCommunicatingSession(options,runtime)).toEqual({ok:true});const identity=await comm.identity(token,false);const originalToken=token;
 release();expect((await delayed).ok).toBe(false);expect(spawns).toBe(1);expect(await comm.identity(originalToken,false)).toEqual(identity);database.close();
});
