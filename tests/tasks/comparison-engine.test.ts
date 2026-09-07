import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PngModule from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextBundle, ComparisonMeasuredTarget } from "@visual-remote/protocol";
import { runDesignComparison, getComparisonArtifact } from "../../packages/bridge-core/src/comparison/engine.js";
import { comparePixels, compareStructure, decodePng } from "../../packages/bridge-core/src/comparison/metrics.js";
const { PNG } = createRequire(new URL("../../packages/bridge-core/package.json", import.meta.url))("pngjs") as typeof PngModule;
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
function image(color:number,width=9,height=9):Buffer{const png=new PNG({width,height});for(let i=0;i<png.data.length;i+=4){png.data[i]=png.data[i+1]=png.data[i+2]=color;png.data[i+3]=255;}return PNG.sync.write(png);}
const url="https://www.figma.com/design/ABC/frame?node-id=1-2";
const target:ComparisonMeasuredTarget={text:"Hello world",rect:{x:0,y:0,width:8,height:8},styles:{color:"#fff",fontSize:"12px"}};
function context():ContextBundle{return {version:1,projectId:"fixture-project",browserSessionId:"00000000-0000-4000-8000-000000000001",page:{url:"http://localhost:3000/",pathname:"/",title:"Fixture",viewport:{width:9,height:9},devicePixelRatio:1,scroll:{x:0,y:0},renderRevision:0},selection:{mode:"page",targets:[]},request:{text:url,scope:"page",comparison:{enabled:true,url,maxIterations:6,targetMatch:99,threshold:30}}};}
async function fixture(){const root=await mkdtemp(join(tmpdir(),"comparison-engine-"));roots.push(root);return {root,taskId:"00000000-0000-4000-8000-000000000002",context:context(),signal:new AbortController().signal,onState:()=>{}};}
describe("real PNG comparison",()=>{
  it("computes all nine regions and genuine red heatmap without resizing",()=>{
    const reference=decodePng(image(255)),current=decodePng(image(255));
    current.data[0]=0;current.data[1]=0;current.data[2]=0;
    const result=comparePixels(reference,current,30);
    expect(result.overallMatch).toBe(80/81*100);expect(result.regions["top-left"]).toBe(8/9*100);expect(result.regions["bot-right"]).toBe(100);
    const heat=decodePng(result.heatmap);expect([...heat.data.subarray(0,4)]).toEqual([255,0,0,255]);expect(decodePng(result.overlay).width).toBe(9);
    expect(()=>comparePixels(reference,decodePng(image(255,6,9)),30)).toThrow(/dimensions differ/u);
  });
  it("rejects decoded dimension bombs before decompression",()=>{const bytes=image(255);bytes.writeUInt32BE(8193,16);expect(()=>decodePng(bytes)).toThrow(/Dimensions/u);expect(()=>decodePng(Buffer.from("not PNG"))).toThrow(/genuine PNG/u);});
  it("counts missing, ambiguous, geometry and style failures truthfully",()=>{
    expect(compareStructure([target],[]).missingTargets).toBe(1);
    expect(compareStructure([target],[target,target]).missingTargets).toBe(1);
    expect(compareStructure([target],[{...target,text:"Hello\n world",styles:{color:"rgb(255, 255, 255)",fontSize:"12"}}]).structuralMismatches).toBe(0);
    expect(compareStructure([target],[{...target,rect:{...target.rect,x:3},styles:{color:"#000"}}]).structuralMismatches).toBe(3);
  });
  it("locks reference before editing, corrects real pixels and serves registered PNG only",async()=>{
    const opts=await fixture();let agentCalls=0,captures=0;
    const result=await runDesignComparison({...opts,runAgent:async()=>{agentCalls++;if(agentCalls===1){await writeFile(join(opts.root,opts.taskId,"reference.png"),image(255));await writeFile(join(opts.root,opts.taskId,"reference.json"),JSON.stringify({width:9,height:9,targets:[],sourceUrl:url,nodeId:"1:2"}));}},capture:async()=>({requestId:"capture",taskId:opts.taskId,width:9,height:9,targets:[],pngBase64:image(++captures===1?0:255).toString("base64")})});
    expect(result.status).toBe("passed");expect(result.iterations.map(i=>i.overallMatch)).toEqual([0,100]);expect(agentCalls).toBe(3);
    const artifact=await getComparisonArtifact(opts.root,result.iterations[0]!.heatmapArtifactId);expect(artifact?.contentType).toBe("image/png");expect(decodePng(artifact!.body as Buffer).width).toBe(9);
    expect(await getComparisonArtifact(opts.root,`${opts.taskId}/reference.json`)).toBeUndefined();expect(await getComparisonArtifact(opts.root,"../reference.png")).toBeUndefined();
    await rm(join(opts.root,opts.taskId,"reference.png"));await symlink(join(opts.root,opts.taskId,"capture-1.png"),join(opts.root,opts.taskId,"reference.png"));expect(await getComparisonArtifact(opts.root,`${opts.taskId}/reference.png`)).toBeUndefined();
    expect(JSON.parse(await readFile(join(opts.root,opts.taskId,"report-2.json"),"utf8")).overallMatch).toBe(100);
  });
  it("blocks unavailable or wrong-provenance references before any edit or capture",async()=>{
    for(const wrong of [false,true]){const opts=await fixture();let calls=0,captured=false;const result=await runDesignComparison({...opts,runAgent:async()=>{calls++;if(wrong){await writeFile(join(opts.root,opts.taskId,"reference.png"),image(255));await writeFile(join(opts.root,opts.taskId,"reference.json"),JSON.stringify({width:9,height:9,targets:[],sourceUrl:url,nodeId:"9:9"}));}},capture:async()=>{captured=true;throw new Error("unexpected");}});expect(result.status).toBe("blocked");expect(result.iterations).toEqual([]);expect(calls).toBe(1);expect(captured).toBe(false);}
  });
  it("stops after three non-improvements and preserves unmatched evidence",async()=>{
    const opts=await fixture();let calls=0;const result=await runDesignComparison({...opts,runAgent:async()=>{if(++calls===1){await writeFile(join(opts.root,opts.taskId,"reference.png"),image(255));await writeFile(join(opts.root,opts.taskId,"reference.json"),JSON.stringify({width:9,height:9,targets:[target],sourceUrl:url,nodeId:"1:2"}));}},capture:async()=>({requestId:"capture",taskId:opts.taskId,width:9,height:9,targets:[],pngBase64:image(255).toString("base64")})});expect(result.status).toBe("unmatched");expect(result.iterations).toHaveLength(4);expect(result.iterations[0]!.missingTargets).toBe(1);
  });
  it("returns canceled without fabricated evidence",async()=>{const opts=await fixture();const controller=new AbortController();controller.abort();const result=await runDesignComparison({...opts,signal:controller.signal,runAgent:async()=>{throw new Error("unexpected");},capture:async()=>{throw new Error("unexpected");}});expect(result.status).toBe("canceled");expect(result.iterations).toEqual([]);});
});
