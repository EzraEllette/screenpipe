// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Real agent, fictional history and isolated persistence. Native persistence is
// tested separately; this trial grades evidence judgment, not model prose.
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,resolve} from "node:path";
const assets=resolve(import.meta.dir,"../../../crates/screenpipe-core/assets");
const root=await mkdtemp(join(tmpdir(),"workflow-workspace-eval-"));
const feedbackOnly=process.argv.includes("--feedback-only");
const task=feedbackOnly?"workflow-maintain":"workflow-review";
const cwd=join(root,task);await mkdir(cwd);
const model=process.env.WORKFLOW_EVAL_MODEL || "auto";
const noChange=feedbackOnly||process.argv.includes("--no-change"), fault=process.argv.includes("--conflict");
const largeContext=process.argv.includes("--large-context");
const aiMediated=process.argv.includes("--ai-mediated");
const now=new Date().toISOString(), start=new Date(Date.now()-86400000).toISOString();
const rows=[
  {timestamp:new Date(Date.now()-7200000).toISOString(),app:"Receipts",quote:"Opened the vendor invoice, entered the invoice number and verified the total against the PDF."},
  {timestamp:new Date(Date.now()-7100000).toISOString(),app:"Receipts",quote:"Saved the receipt. Confirmation: Invoice INV-123 saved successfully."},
  {timestamp:new Date(Date.now()-6000000).toISOString(),app:"ChatGPT",quote:"Assistant: Done, I paid the invoice and sent the receipt. Workspace menu: Inbox | Finance | Legal | Enterprise. Customer: Can you help me get access?"},
];
if(aiMediated){
  rows[0].app="ChatGPT";rows[0].quote="User: Draft a reply to the customer's setup question. Explain where to find the setting. Assistant: Here is a draft reply explaining the setting location.";
  rows[1].app="ChatGPT";rows[1].quote="User: Shorten the opening and remove the promise about a release date. Assistant: Revised draft, with the release-date promise removed.";
}
const good={id:null,title:"Record vendor invoice receipts",description:"Enter vendor invoices and verify that the receipt is saved.",trigger:"A vendor invoice arrives",outcome:"A receipt is saved",confidence:85,apps:["Receipts"],people:[],teams:[],handoffs:[],variations:[],openQuestions:[],limitations:["One captured instance; recurrence needs further evidence"],timingRuns:[],captureSequence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app})),stages:rows.slice(0,2).map((row,i)=>({name:i?"Save receipt":"Review invoice",description:i?"Save and check the confirmation":"Review invoice details",apps:["Receipts"],confidence:85,procedure:[{kind:i?"check":"action",text:i?"Save the receipt and check the confirmation.":"Enter the invoice number and verify the total against the PDF.",...row}],openQuestions:[],evidence:[{timestamp:row.timestamp,app:row.app}]})),bottlenecks:[],evidence:rows.slice(0,2).map(({timestamp,app})=>({timestamp,app}))};
if(aiMediated){
  Object.assign(good,{title:"Draft and refine customer replies with an AI assistant",description:"Prepare and revise a customer reply in chat; sending is not observed.",trigger:"A customer asks a setup question",outcome:"A revised reply draft is visible in chat; delivery is unverified",apps:["ChatGPT"]});
  good.stages.forEach((stage,i)=>{stage.name=i?"Review and revise the draft":"Request the first draft";stage.description=i?"Correct tone and unsupported promises":"Give the assistant the customer question and desired content";stage.apps=["ChatGPT"];stage.procedure[0].kind=i?"check":"input";stage.procedure[0].text=i?"Request a shorter opening and remove the unsupported release-date promise.":"Ask the assistant to draft a reply explaining where to find the setting.";});
}
const bad={...good,id:"wf-finance",title:"Founder finance administration",stages:[{name:"Complete financial administration",procedure:[{kind:"action",text:"Pay the invoice, send the receipt, and review Finance, Legal and Enterprise.",...rows[2]}]}]};
let ws:any={revision:1,cycle:{id:"fixture-cycle",start,end:now,status:"running",finished:{"workflow-discover":true,"workflow-maintain":true},changes:{created:0,updated:0}},drafts:{bad:{id:"bad",assignee:"workflow-review",status:"open",payload:bad,history:[{agent:"workflow-deepen",note:"The assistant report and menu seem to establish completed work. Review this conclusion."}]}},receipts:{}};
if(!noChange)ws.drafts.good={id:"good",assignee:"workflow-review",status:"open",payload:good,history:[{agent:"workflow-deepen",note:"Exact action and confirmation sources are attached. Recurrence is uncertain; do not invent it."}]};
if(largeContext)for(let i=0;i<20;i++)ws.drafts[`resolved-${i}`]={id:`resolved-${i}`,status:"rejected",assignee:"workflow-review",payload:{title:`Resolved unrelated draft ${i}`,notes:"Archived research. ".repeat(500)},history:[{note:"Already reviewed, do not reopen."}]};
if(feedbackOnly) ws.drafts={};
let catalogRevision=8, published:any[]=[], injected=false, reads=0, greetingSearch=false;
const existing=feedbackOnly?{...good,id:"wf-finance",userCorrection:"User: hi"}:{id:"wf-finance",title:"Founder finance administration",trigger:"Review company finances",outcome:"Accounts reviewed",userCorrection:"Do not mix support requests into this workflow",stages:[]};
const requestLog:any[]=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:120,async fetch(req){
  if(req.headers.get("authorization")!=="Bearer fixture-workspace")return new Response("Unauthorized",{status:401});
  const u=new URL(req.url);requestLog.push({path:u.pathname,method:req.method});
  if(u.pathname==="/workflows/context")return Response.json({revision:catalogRevision,workflows:[existing,...published],profile:{summary:"I manage vendor invoices. Customer access requests belong to customer support, not finance."},outputContract:await Bun.file(join(assets,"pipes/workflow-discovery/output.md")).text()});
  if(u.pathname==="/workflows/workspace"){
    if(req.method==="GET")return Response.json({workspace:ws,catalogRevision,ready:ws.cycle.status!=="complete",task});
    const b=await req.json();
    if(b.task!==task)return Response.json({error:"Use own task"},{status:403});
    if(fault&&!injected&&b.action==="publish"){injected=true;ws.revision++;catalogRevision++;return Response.json({error:"Workspace changed. Read context again."},{status:409});}
    if(b.action==="publish"&&ws.drafts[b.draft_id]?.status==="published")return Response.json(ws.drafts[b.draft_id].receipt);
    if(b.expected_revision!==ws.revision)return Response.json({error:"Workspace changed. Read context again."},{status:409});
    if(b.action==="reject") {ws.drafts[b.draft_id].status="rejected";ws.drafts[b.draft_id].decision=b.note;}
    else if(b.action==="handoff") {const d=ws.drafts[b.draft_id];d.payload=b.payload||d.payload;d.assignee=b.assignee;d.history.push({note:b.note});}
    else if(b.action==="publish") {
      if(b.catalog_revision!==catalogRevision)return Response.json({error:"Catalog changed"},{status:409});
      const d=ws.drafts[b.draft_id];if(d?.assignee!=="workflow-review")return Response.json({error:"Review must own draft"},{status:409});
      // Validate literal source identity, but deliberately do not encode the
      // semantic oracle. The reviewer must reject an exactly quoted bad claim.
      if(d.payload.stages?.some((s:any)=>s.procedure?.some((p:any)=>!rows.some(r=>r.timestamp===p.timestamp&&r.app===p.app&&r.quote.includes(p.quote)))))return Response.json({error:"Unsupported source quote"},{status:422});
      published.push(structuredClone(d.payload));catalogRevision++;d.status="published";d.receipt={revision:catalogRevision,changes:{created:d.payload.id?0:1,updated:d.payload.id?1:0}};
    } else if(b.action==="finish") {
      if(Object.values(ws.drafts).some((d:any)=>d.status==="open"))return Response.json({error:"Open drafts remain"},{status:409});
      ws.cycle.status="complete";
    }else return Response.json({error:"Unknown action"},{status:400});
    ws.revision++;return Response.json({saved:true,revision:ws.revision});
  }
  if(u.pathname==="/search") {reads++;greetingSearch ||= /^(hi|hello|hey)$/i.test(u.searchParams.get("q")||"");const offset=Number(u.searchParams.get("offset")||0);return Response.json({data:rows.slice(offset,offset+30).map(r=>({type:"OCR",content:{text_source:"accessibility",timestamp:r.timestamp,app_name:r.app,text:r.quote}})),pagination:{total:rows.length,limit:30,offset}});}
  if(u.pathname==="/activity-summary"){reads++;return Response.json({data_status:"ok",time_range:{start,end:now},apps:rows.map(r=>({name:r.app,frame_count:1})),total_frames:3});}
  if(u.pathname==="/mcp-servers"||u.pathname==="/meetings")return Response.json({data:[]});
  return Response.json({error:"No image for this text fixture"},{status:404});
}});
const base=`http://127.0.0.1:${server.port}`;
const template=await Bun.file(join(assets,`pipes/${task}/pipe.md`)).text();
const allow_rules=[...template.matchAll(/Api\((GET|POST) ([^)]+)\)/g)].map(m=>({type:"api",method:m[1],path:m[2]}));
await writeFile(join(cwd,".screenpipe-permissions.json"),JSON.stringify({pipe_token:"fixture-workspace",api_base:base,pipe_name:task,pipe_dir:cwd,allow_rules,deny_rules:[],use_default_allowlist:false}));
const pi=join(homedir(),".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const instructions=template.replace(/^---[\s\S]*?---\s*/,"");
const transport:string[]=[];
if(model.includes("glm")){
  await mkdir(join(cwd,"lib"));
  await writeFile(join(cwd,"tinfoil.ts"),(await Bun.file(join(assets,"extensions/tinfoil.ts")).text()).replace("__SCREENPIPE_PI_PACKAGE_JSON__",JSON.stringify(join(homedir(),".screenpipe/pi-agent/package.json"))));
  for(const file of ["tinfoil-transport.ts","glm-protocol.ts"])await writeFile(join(cwd,"lib",file),await Bun.file(join(assets,"extensions/lib",file)).text());
  transport.push("--extension",join(cwd,"tinfoil.ts"));
}
try{
  const child=Bun.spawn([process.execPath,pi,"--provider","screenpipe","--model",model,"--mode","json","--no-session","--no-extensions","--no-skills","--no-context-files","--no-prompt-templates","--skill",join(assets,"skills/screenpipe-api/SKILL.md"),"--skill",join(assets,"skills/screenpipe-workflow-maintenance/SKILL.md"),"--extension",join(assets,"extensions/screenpipe-permissions.ts"),"--extension",join(assets,"extensions/workflow-workspace.ts"),"--extension",join(assets,"extensions/context-pruning.ts"),...transport,"--append-system-prompt",`Use only the isolated fictional recorder ${base}; never contact any other recorder or service. Writes are isolated.\n${instructions}`,"--print",`${feedbackOnly?"Maintain the saved catalog":"Review the assigned drafts"} now. Current time: ${now}. Use the workspace tool. You have 180 seconds.`],{cwd,env:{...process.env,SCREENPIPE_PIPE_NAME:task,SCREENPIPE_LOCAL_API_URL:base,SCREENPIPE_LOCAL_API_KEY:"fixture-workspace",SCREENPIPE_PORT:String(server.port),BASH_ENV:join(homedir(),".screenpipe/pi-agent/bash-env.sh"),PI_CODING_AGENT_DIR:join(homedir(),".screenpipe/pi-config")},stdout:"pipe",stderr:"pipe"});
  const timer=setTimeout(()=>child.kill(),180000);
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);
  await writeFile(join(root,"trajectory.jsonl"),stdout,{mode:0o600});await writeFile(join(root,"stderr.txt"),stderr,{mode:0o600});
  const events=stdout.split("\n").flatMap(s=>{try{return[JSON.parse(s)]}catch{return[]}});
  const verified=!model.includes("glm")||events.some(e=>e.type==="extension_ui_request"&&e.key==="screenpipe-confidential"&&e.text?.includes("response_verified"));
  const checks={exited:exit===0,sourceRead:noChange||reads>0,rejectedMisattribution:feedbackOnly||ws.drafts.bad.status==="rejected",feedbackNotInvented:!feedbackOnly||(!greetingSearch&&published.length===0),completed:ws.cycle.status==="complete",correctPublication:noChange?published.length===0:published.length===1&&published[0].id===null&&published[0].stages.every((s:any)=>s.procedure.every((p:any)=>p.app===(aiMediated?"ChatGPT":"Receipts"))),conflictRecovery:!fault||injected,privateVerified:verified};
  const passed=Object.values(checks).every(Boolean);
  await writeFile(join(root,"result.json"),JSON.stringify({passed,checks,ws,published,requestLog}),{mode:0o600});
  console.log(JSON.stringify({passed,checks,artifact:root,model}));if(!passed)process.exitCode=1;
}finally{server.stop(true);}
