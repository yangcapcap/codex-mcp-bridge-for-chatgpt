import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { dashboardView } from "./card-browser-fixtures.js";

const artifacts = path.resolve("output/playwright/issue-126-live-card-completion");
mkdirSync(artifacts, { recursive: true });
const session = `issue-126-live-card-${process.pid}`;
const execute = promisify(execFile);
const jobId = "12600000-0000-4000-8000-000000000001";
const presentationRef = "a".repeat(64);
const mismatchedRef = "b".repeat(64);
const receipt = `completion-${"c".repeat(64)}`;

const toolInput = { arguments: { scope: "conversation", jobId, presentationRef } };
const toolResult = (ref = presentationRef, route: "live-card" | "direct-wait" = "live-card") => ({
  structuredContent: {
    kind: "dashboard",
    scope: "conversation",
    readOnly: true,
    statusSource: "codex-runtime-only",
    summary: "Issue 126 automatic completion fixture"
  },
  _meta: {
    "codex/dashboardOpen@1": {
      scope: "conversation",
      automatic: true,
      presentationRef: ref,
      completionDeliveryRoute: route
    }
  }
});

function cardHtml(): string {
  const base = dashboardView("structural");
  const view = {
    ...base,
    scope: "conversation",
    statusFilter: "all",
    historyIncluded: false,
    statusRows: [],
    statusRowsComplete: true,
    filter: {
      mode: "conversation",
      conversationAvailable: true,
      conversationHasWork: true
    }
  };
  const prelude = `<script>(()=>{
    const view=${JSON.stringify(view)};
    window.__errors=[];
    window.addEventListener("error",event=>window.__errors.push(String(event.error&&event.error.message||event.message)));
    window.addEventListener("unhandledrejection",event=>window.__errors.push(String(event.reason&&event.reason.message||event.reason)));
    window.openai={locale:"ko-KR",toolInput:null,toolOutput:null,toolResponseMetadata:null,notifyIntrinsicHeight:()=>{},callTool:async()=>({structuredContent:view})};
  })();</script>`;
  return DASHBOARD_CARD_HTML
    .replace("TOOL_CALL_TIMEOUT_MS=15000", "TOOL_CALL_TIMEOUT_MS=300")
    .replace("COMPLETION_WAIT_MS=8000", "COMPLETION_WAIT_MS=100")
    .replace("COMPLETION_MESSAGE_TIMEOUT_MS=12000", "COMPLETION_MESSAGE_TIMEOUT_MS=250")
    .replace("</head>", `${prelude}</head>`);
}

function hostHtml(scenario: string): string {
  const frameCount = scenario === "duplicate-cards" ? 2 : 1;
  return `<!doctype html><html><body><script>(()=>{
    const scenario=${JSON.stringify(scenario)},input=${JSON.stringify(toolInput)},result=${JSON.stringify(toolResult())},direct=${JSON.stringify(toolResult(presentationRef, "direct-wait"))},mismatch=${JSON.stringify(toolResult(mismatchedRef))};
    window.__events=[];window.__messageCount=0;window.__settled=false;window.__claimed=false;window.__waitCount=0;window.__readyFrames=0;
    const frames=[];
    const delivery=(state,extra={})=>({structuredContent:{kind:"job-completion-delivery",state,...extra}});
    const send=(frame,method,params,id)=>frame.contentWindow.postMessage({jsonrpc:"2.0",...(id===undefined?{}:{id}),method,params},"*");
    const reply=(frame,id,result,error)=>frame.contentWindow.postMessage({jsonrpc:"2.0",id,...(error?{error}:{result})},"*");
    for(let index=0;index<${frameCount};index+=1){const frame=document.createElement("iframe");frame.src="/card?index="+index;frame.dataset.index=String(index);document.body.appendChild(frame);frames.push(frame)}
    window.addEventListener("message",event=>{
      const frame=frames.find(candidate=>candidate.contentWindow===event.source);if(!frame)return;
      const message=event.data;if(!message||message.jsonrpc!=="2.0")return;
      const frameIndex=Number(frame.dataset.index);
      if(message.method==="ui/initialize"&&message.id!==undefined){
        if(scenario==="mismatch"){send(frame,"ui/notifications/tool-input",input);send(frame,"ui/notifications/tool-result",mismatch)}
        else if(scenario==="direct-wait-route"){send(frame,"ui/notifications/tool-input",input);send(frame,"ui/notifications/tool-result",direct)}
        else{send(frame,"ui/notifications/tool-input",input);send(frame,"ui/notifications/tool-result",result)}
        reply(frame,message.id,{protocolVersion:"2026-01-26",hostContext:{locale:"ko-KR"}});window.__readyFrames+=1;return;
      }
      if(message.method==="tools/call"&&message.id!==undefined){
        const args=message.params&&message.params.arguments||{},operation=args.operation;window.__events.push({frame:frameIndex,type:"tool",name:message.params.name,operation});
        if(message.params.name==="codex_status"){
          if(args.query?.kind!=="completion"||args.query?.receipt!==${JSON.stringify(receipt)}){reply(frame,message.id,undefined,{code:-32000,message:"Wrong completion identity"});return}
          // A second installation has the same tool names. This frame remains bound to its own connection.
          reply(frame,message.id,{structuredContent:{kind:"job",items:[{type:"job",id:${JSON.stringify(jobId)},terminal:true,state:"completed",answer:"Originating connection result"}]},content:[{type:"text",text:"Originating connection result"}],_meta:{privateProof:"must-not-be-forwarded"}});return;
        }
        if(message.params.name!=="codex_ui_completion"){reply(frame,message.id,delivery("settled"));return}
        if(operation==="wait"){
          window.__waitCount+=1;
          if(scenario==="direct-result-read"){
            window.__settled=true;reply(frame,message.id,delivery("settled",{deliveryState:"result-read"}));return;
          }
          if(scenario==="teardown-before-terminal"){
            reply(frame,message.id,delivery("waiting",{deliveryState:"pending"}));
            setTimeout(()=>send(frame,"ui/resource-teardown",{},9000+frameIndex),20);return;
          }
          if(window.__settled){reply(frame,message.id,delivery("settled",{deliveryState:"host-accepted"}));return}
          if(scenario==="duplicate-cards"&&window.__claimed){reply(frame,message.id,delivery("waiting",{deliveryState:"leased"}));return}
          window.__claimed=true;reply(frame,message.id,delivery("claimed",{receipt:${JSON.stringify(receipt)},attempt:window.__waitCount,leaseExpiresAt:"2026-09-18T00:00:20.000Z",deliveryState:"leased"}));return;
        }
        if(operation==="release"){window.__claimed=false;reply(frame,message.id,delivery("waiting",{deliveryState:"pending"}));return}
        if(operation==="rejected"){window.__claimed=false;reply(frame,message.id,delivery("waiting",{deliveryState:"host-rejected"}));return}
        if(operation==="accepted"||operation==="uncertain"){window.__settled=true;reply(frame,message.id,delivery("settled",{deliveryState:operation==="accepted"?"host-accepted":"acceptance-unknown"}));return}
        reply(frame,message.id,delivery("settled"));return;
      }
      if(message.method==="ui/message"&&message.id!==undefined){
        window.__messageCount+=1;window.__events.push({frame:frameIndex,type:"message",content:message.params&&message.params.content});
        if(scenario==="timeout-unknown")return;
        if(scenario==="teardown-during-send"){send(frame,"ui/resource-teardown",{},9100+frameIndex);return}
        if(scenario==="reject-then-accept"&&window.__messageCount===1){reply(frame,message.id,undefined,{code:-32000,message:"model response still active"});return}
        reply(frame,message.id,{});return;
      }
      if(message.method==="ui/notifications/initialized")window.__events.push({frame:frameIndex,type:"initialized"});
    });
  })();</script></body></html>`;
}

async function cli(...args: string[]): Promise<string> {
  const result = await execute(
    "npx",
    ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
  );
  return result.stdout.trim();
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(url.pathname === "/card" ? cardHtml() : hostHtml(url.searchParams.get("scenario") || "accept"));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const scenarios = [
  "accept",
  "reject-then-accept",
  "timeout-unknown",
  "teardown-during-send",
  "direct-result-read",
  "teardown-before-terminal",
  "direct-wait-route",
  "mismatch",
  "duplicate-cards"
] as const;
const results: Array<Record<string, unknown>> = [];

try {
  await cli("open", `http://127.0.0.1:${port}/?scenario=${scenarios[0]}`);
  for (const [index, scenario] of scenarios.entries()) {
    if (index > 0) await cli("goto", `http://127.0.0.1:${port}/?scenario=${scenario}`);
    const raw = await cli("run-code", `async page=>{
      const scenario=${JSON.stringify(scenario)};
      await page.waitForFunction(s=>{
        const frames=[...document.querySelectorAll("iframe")],datasets=frames.map(frame=>{try{return{...frame.contentDocument.documentElement.dataset}}catch{return{}}});
        if(s==="accept")return window.__settled&&window.__messageCount===1;
        if(s==="reject-then-accept")return window.__settled&&window.__messageCount===2;
        if(s==="timeout-unknown")return window.__settled&&datasets[0]?.completionDelivery==="acceptance-unknown";
        if(s==="teardown-during-send")return datasets[0]?.completionDelivery==="acceptance-unknown";
        if(s==="direct-result-read")return window.__settled&&window.__waitCount===1;
        if(s==="teardown-before-terminal")return window.__events.some(event=>event.operation==="wait")&&datasets[0]?.dashboardPresentation==="ready";
        if(s==="direct-wait-route")return datasets[0]?.dashboardPresentation==="ready"&&datasets[0]?.completionDeliveryRoute==="direct-wait";
        if(s==="mismatch")return datasets[0]?.dashboardPresentation==="mismatch";
        return s==="duplicate-cards"&&window.__settled&&window.__readyFrames===2;
      },scenario,{timeout:5000}).catch(()=>{});
      if(["direct-result-read","teardown-before-terminal","direct-wait-route","teardown-during-send","mismatch","duplicate-cards","timeout-unknown"].includes(scenario))await page.waitForTimeout(1200);
      const frames=page.frames().filter(frame=>frame.url().includes("/card?"));
      const host=await page.evaluate(()=>({events:window.__events,messageCount:window.__messageCount,waitCount:window.__waitCount,settled:window.__settled}));
      return {...host,datasets:await Promise.all(frames.map(frame=>frame.evaluate(()=>({...document.documentElement.dataset})))),errors:(await Promise.all(frames.map(frame=>frame.evaluate(()=>window.__errors)))).flat()};
    }`);
    const observed = JSON.parse(raw) as {
      events: Array<{ type: string; name?: string; operation?: string; content?: unknown }>;
      messageCount: number;
      waitCount: number;
      settled: boolean;
      datasets: Array<Record<string, string>>;
      errors: string[];
    };
    assert.deepEqual(observed.errors, [], scenario);
    for(const message of observed.events.filter(event=>event.type==="message")){
      const text=JSON.stringify(message.content);
      assert.equal(text.includes("Originating connection result"),true,scenario);
      assert.equal(text.includes("Use only Codex MCP Bridge for ChatGPT"),false,scenario);
      assert.equal(text.includes("must-not-be-forwarded"),false,scenario);
      assert.equal(text.includes(receipt),false,scenario);
    }
    const diagnosticText = JSON.stringify(observed.datasets);
    assert.equal(diagnosticText.includes(jobId), false, `${scenario}: raw Job ID leaked into diagnostics`);
    assert.equal(diagnosticText.includes(presentationRef), false, `${scenario}: presentation ref leaked into diagnostics`);
    if (scenario === "accept") {
      assert.equal(observed.messageCount, 1);
      assert.deepEqual(observed.events.filter(event => event.operation).map(event => event.operation), ["wait", "accepted"]);
      assert.equal(observed.datasets[0]?.completionDelivery, "host-accepted");
    } else if (scenario === "reject-then-accept") {
      assert.equal(observed.messageCount, 2);
      assert.deepEqual(observed.events.filter(event => event.operation).map(event => event.operation), ["wait", "rejected", "wait", "accepted"]);
    } else if (scenario === "timeout-unknown") {
      assert.equal(observed.messageCount, 1);
      assert.deepEqual(observed.events.filter(event => event.operation).map(event => event.operation), ["wait", "uncertain"]);
      assert.equal(observed.datasets[0]?.completionDelivery, "acceptance-unknown");
    } else if (scenario === "teardown-during-send") {
      assert.equal(observed.messageCount, 1);
      assert.deepEqual(observed.events.filter(event => event.operation).map(event => event.operation), ["wait"]);
      assert.equal(observed.datasets[0]?.completionDelivery, "acceptance-unknown");
    } else if (scenario === "direct-result-read") {
      assert.equal(observed.messageCount, 0);
      assert.deepEqual(observed.events.filter(event => event.operation).map(event => event.operation), ["wait"]);
    } else if (scenario === "teardown-before-terminal") {
      assert.equal(observed.messageCount, 0);
      assert.equal(observed.waitCount, 1);
    } else if (scenario === "direct-wait-route") {
      assert.equal(observed.messageCount, 0);
      assert.equal(observed.waitCount, 0);
      assert.equal(observed.datasets[0]?.completionDeliveryRoute, "direct-wait");
    } else if (scenario === "mismatch") {
      assert.equal(observed.messageCount, 0);
      assert.equal(observed.waitCount, 0);
    } else {
      assert.equal(observed.messageCount, 1);
      assert.equal(observed.events.filter(event => event.operation === "accepted").length, 1);
    }
    results.push({ scenario, ...observed, passed: true });
  }
  writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(artifacts, "final.snapshot.txt"), await cli("snapshot"));
  console.log(`Issue #126 live-card completion: ${results.length}/${scenarios.length} browser scenarios passed.`);
} catch (error) {
  writeFileSync(path.join(artifacts, "failure.txt"), String(error));
  throw error;
} finally {
  try {
    await cli("close");
  } finally {
    server.close();
  }
}
