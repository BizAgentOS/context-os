import { metricReferenceSchema } from "../semantic/metric-contract.ts";
import { publicMetric } from "../semantic/metric-reading.ts";
import { freezeLegacyConsumption } from "./legacy-consumption.ts";
import { snapshotPinsForRelease } from "./release-pins.ts";
import type { SnapshotPins } from "./memory.ts";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Artifact, Data } from "../agent/contracts.ts";
import type { MemoryStore } from "../agent/memory.ts";
import { FoundationService } from "../agent/foundation.ts";
import type { LiveMemory } from "./memory.ts";
import { jsonData } from "./sources.ts";
import { ConsumerViews, consumerGrant } from "./consumer-views.ts";
import {SemanticConsumption,externalSemanticOperations,externalObjectsSchema} from './semantic-consumption.ts';
import {ConsumerScopeError} from './consumer-semantic.ts';

const name = z.string().trim().min(1).max(200);
const ref = z.object({ id: name, version: z.number().int().positive() }).strict();
const ids = z.array(name).max(120).refine(a => new Set(a).size === a.length, "选择不能重复");
const publishInput = z.object({
  operationId: name, name, foundationRef: ref,
  conceptIds: ids.refine(a => a.length > 0, "至少选择一个概念"), relationIds: ids, metricIds: ids.default([]),
  business: z.object({ modelRef: ref, grants: z.array(consumerGrant).min(1).max(20) }).strict().optional(),
}).strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const semantic = (a: Artifact) => ({
  concepts: (a.content.concepts ?? []) as Data[],
  relations: (a.content.relations ?? []) as Data[],
});
function publicDataset(a: Artifact) {
  const { keyHash, operationSignature, operationId, ...content } = a.content;
  return { ...a, content };
}

/** A deliberately selected, versioned semantic dataset for an external MCP caller. */
export class OntologyDatasets {
  private memory: MemoryStore;
  private live: LiveMemory;
  constructor(memory: MemoryStore, live: LiveMemory) { this.memory = memory; this.live = live; }

  private foundation(input: { id: string; version: number }) {
    const a = this.memory.getArtifact(input.id, input.version);
    if (a.kind !== "foundation" || a.status !== "adopted") throw new Error("请先在本体工作区采用该版本，再开放数据集");
    return a;
  }
  private dataset(id: string) {
    const a = this.memory.getArtifact(id);
    if (a.kind !== "ontology_dataset") throw new Error("数据集不存在");
    return a;
  }
  list() {
    const { current, adopted } = new FoundationService(this.memory).read();
    let model: Data | null = null;
    const active = this.memory.listArtifacts("live_ontology").find(a => a.status === "adopted");
    if (active && adopted) {
      try {
        const current = this.live.assertModel(active.id, active.version);
        const f = current.content.foundationRef as Data | undefined;
        if (f?.id === adopted.id && f.version === adopted.version) model = jsonData({
          id: current.id, version: current.version, title: current.title,
          types: (current.content.types as Data[]).map(t => ({
            name: t.name, conceptId: t.conceptId,
            fields: [...new Set(["$id", ...Object.keys(t.fields as Data), ...((t.supplements ?? []) as Data[]).flatMap(s => Object.keys(s.fields as Data))])],
          })),
          relations: (current.content.relations as Data[]).map(r => ({ name: r.name, relationId: r.relationId, from: r.from, to: r.to, fromField: r.fromField, toField: r.toField })),
        });
      } catch { /* Invalid mappings remain in the workspace, not in the publication picker. */ }
    }
    const access = new Map(this.memory.listArtifacts("dataset_access").map(a => [a.content.datasetId, a.content]));
    return {
      model,
      current: current ? { id: current.id, version: current.version, status: current.status } : null,
      foundation: adopted ? {
        id: adopted.id, version: adopted.version,
        enterprise: (adopted.content.enterprise as Data).name,
        ...this.select(adopted, semantic(adopted).concepts.map(c => String(c.id)), semantic(adopted).relations.map(r => String(r.id))),
      } : null,
      datasets: this.memory.listArtifacts("ontology_dataset").map(a => ({
        ...publicDataset(a), access: access.get(a.id) ?? null,
      })),
    };
  }
  private select(foundation: Artifact, conceptIds: string[], relationIds: string[]) {
    const data = semantic(foundation);
    if (conceptIds.some(id => !data.concepts.some(c => c.id === id))) throw new Error("所选概念不属于该本体版本");
    if (relationIds.some(id => !data.relations.some(r => r.id === id && conceptIds.includes(String(r.from)) && conceptIds.includes(String(r.to)))))
      throw new Error("关系的两端概念必须同时开放");
    return {
      concepts: data.concepts.filter(c => conceptIds.includes(String(c.id))).map(c => ({ id: c.id, name: c.name, description: c.description, origin: "adopted_interpretation" })),
      relations: data.relations.filter(r => relationIds.includes(String(r.id))).map(r => ({ id: r.id, name: r.name, description: r.description, from: r.from, to: r.to, origin: "adopted_interpretation" })),
    };
  }
  publish(_input: unknown, _options: { fixedSemantic?: boolean; snapshotPins?: SnapshotPins; releaseRef?: { id: string; version: number } } = {}): { dataset: Artifact; key: string | null; keyAvailable: boolean } {
    return freezeLegacyConsumption();
  }
  /** Published releases own semantics and pins; compatibility options cannot override either. */
  publishForRelease(input: unknown, releaseRef: { id: string; version: number }, _options: { fixedSemantic?: boolean; snapshotPins?: SnapshotPins } = {}) {
    const release = this.memory.getArtifact(releaseRef.id, releaseRef.version);
    if (release.kind !== "data_release" || release.status !== "published") throw new Error("需要已发布版本");
    const args = publishInput.parse(input);
    const foundationRef = release.content.foundationRef as { id: string; version: number };
    if (foundationRef.id !== args.foundationRef.id || foundationRef.version !== args.foundationRef.version) throw new Error("本体必须属于指定发布版本");
    const signature = digest(JSON.stringify({ ...args, releaseRef }));
    return this.memory.atomic(() => {
      const prior = this.memory.listArtifacts("ontology_dataset").find(a => a.content.operationId === args.operationId);
      if (prior) {
        if (prior.content.operationSignature !== signature) throw new Error("同一操作标识不能发布不同范围");
        return { dataset: publicDataset(prior), key: null, keyAvailable: false };
      }
      const foundation = this.foundation(args.foundationRef);
      const selection = this.select(foundation, args.conceptIds, args.relationIds);
      const available = metricReferenceSchema.array().parse((release.content.definition as Data).metricReferences ?? []);
      const metricReferences = args.metricIds.map(id => {
        const metric = available.find(item => item.id === id && args.conceptIds.includes(item.entityTypeId));
        if (!metric) throw new Error("指标不属于所选发布实体范围");
        this.live.sources.capability(metric.sourceId, metric.capability, metric.connectionVersion);
        return metric;
      });
      let business: Data | null = null;
      if (args.business) {
        const releasedModelRef = release.content.modelRef as { id: string; version: number } | null;
        if (!releasedModelRef || releasedModelRef.id !== args.business.modelRef.id || releasedModelRef.version !== args.business.modelRef.version) throw new Error("业务映射必须属于指定发布版本");
        const definition = (release.content.definition as Data | undefined)?.model;
        if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error("发布版本缺少固定业务映射");
        const modelDefinition = jsonData({ ...definition, foundationRef: release.content.foundationRef });
        const model = this.live.assertModel(args.business.modelRef.id, args.business.modelRef.version, true, snapshotPinsForRelease(release.content.definition as Data), modelDefinition);
        const f = model.content.foundationRef as Data | undefined;
        if (model.status !== "adopted" || f?.id !== foundation.id || f.version !== foundation.version) throw new Error("业务映射必须属于同一已采用本体版本");
        for (const grant of args.business.grants) {
          const type = (model.content.types as Data[]).find(t => t.name === grant.type);
          if (!type || !args.conceptIds.includes(String(type.conceptId))) throw new Error("业务类型必须属于已开放概念");
          for (const relation of grant.relations) {
            const r = (model.content.relations as Data[]).find(r => r.from === grant.type && r.name === relation);
            if (!r || !args.relationIds.includes(String(r.relationId))) throw new Error("业务关系必须属于已开放本体关系");
          }
        }
        const views = new ConsumerViews(this.memory, this.live);
        const view = views.createForRelease({ ...args.business, operationId: "dataset:" + args.operationId, name: args.name, purpose: "MCP 本体数据集" }, releaseRef);
        business = jsonData({ viewRef: { id: view.id, version: view.version }, ...args.business });
      }
      const key = "cos_dataset_" + randomBytes(32).toString("base64url");
      const dataset = this.memory.putArtifact({
        kind: "ontology_dataset", title: args.name, status: "active",
        content: jsonData({
          releaseRef, foundationRef: args.foundationRef, enterprise: (foundation.content.enterprise as Data).name,
          ...selection, metricIds: args.metricIds, metricReferences, business, operationId: args.operationId, operationSignature: signature,
          keyHash: digest(key), publishedAt: new Date().toISOString(),
        }),
      });
      return { dataset: publicDataset(dataset), key, keyAvailable: true };
    });
  }
  revoke(input: unknown) {
    const r = ref.parse(input);
    return this.memory.atomic(() => {
      const a = this.dataset(r.id);
      if (a.status === "revoked" && a.version === r.version + 1) return publicDataset(a);
      if (a.version !== r.version || a.status !== "active") throw new Error("数据集状态已变化，请刷新");
      const business = a.content.business as Data | null;
      if (business) {
        const linked = this.memory.getArtifact(String((business.viewRef as Data).id));
        if (linked.status !== "revoked") new ConsumerViews(this.memory, this.live).revoke({ id: linked.id, version: linked.version });
      }
      return publicDataset(this.memory.putArtifact({ ...a, expectedVersion: a.version, status: "revoked", content: { ...a.content, revokedAt: new Date().toISOString() } }));
    });
  }
  connection(input: unknown, origin: string) {
    const r = ref.parse(input), a = this.dataset(r.id);
    if(!this.published(a))throw new Error('旧独立数据集服务已下线；请通过已发布版本创建接入方');
    if (a.version !== r.version || a.status !== "active") throw new Error("数据集已变化或停用");
    return {
      dataset: publicDataset(a), transport: "stdio", localOnly: true,
      mcp: { mcpServers: { ["context-os-" + a.id]: {
        command: process.execPath,
        args: [fileURLToPath(new URL("../../scripts/context-os-mcp.ts", import.meta.url))],
        env: { CONTEXT_OS_URL: origin, CONTEXT_OS_CONSUMER_KEY: "<本数据集接入密钥>" },
      } } },
      http:{baseUrl:origin,authorization:"Bearer <本数据集接入密钥>",endpoints:[
        {method:"GET",path:"/v4/dataset",description:"读取获准目录"},
        {method:"GET",path:"/v4/objects",description:"按授权类型读取对象；filters、sort 使用 JSON 参数",inputSchema:z.toJSONSchema(externalObjectsSchema)},
        ...externalSemanticOperations.map(operation=>({method:"GET",path:operation.path,description:operation.description,encoding:operation.path==="/v4/search"?"query/offset/limit 参数":"query 参数为 JSON 查询表达式",inputSchema:z.toJSONSchema(operation.schema)})),
      ]},
      tools: ["describe_dataset", "read_concept", "query_relations", "describe_type", "query_objects", "read_evidence",...externalSemanticOperations.map(item=>item.name)],
    };
  }
  authenticate(key: string) {
    if (!/^(?:cos|de)_dataset_[A-Za-z0-9_-]+$/.test(key)) return undefined;
    return this.memory.listArtifacts("ontology_dataset").find(a => a.status === "active" && a.content.keyHash === digest(key) && this.published(a));
  }
  private published(dataset:Artifact){
    const reference=dataset.content.releaseRef as Data|undefined;
    if(!reference)return false;
    try{const release=this.memory.getArtifact(String(reference.id),Number(reference.version));return release.kind==='data_release'&&release.status==='published';}catch{return false;}
  }
  /** Revalidate current source authority before returning saved delegated results. */
  assertReadable(key: string) {
    const dataset = this.authenticate(key);
    if (!dataset) throw new Error("数据集密钥无效或已停用");
    const business = dataset.content.business as Data | null;
    for (const metric of metricReferenceSchema.array().parse(dataset.content.metricReferences ?? [])) this.live.sources.capability(metric.sourceId, metric.capability, metric.connectionVersion);
    if (business) new ConsumerViews(this.memory, this.live).assertLinkedReadable(business.viewRef as { id: string; version: number });
    return dataset;
  }
  usage(id:string){
    const access=this.memory.listArtifacts("dataset_access").find(item=>item.content.datasetId===id)?.content;
    return {calls:Number(access?.count??0),succeeded:Number(access?.succeeded??access?.count??0),failed:Number(access?.failed??0),lastReadAt:access?.lastReadAt??null,recentErrors:access?.recentErrors??[]};
  }
  private recordRead(a:Artifact,path:string,status:number,elapsedMs:number){
    const route=["/v4/dataset","/v4/concept","/v4/relations","/v4/types","/v4/objects","/v4/evidence",...externalSemanticOperations.map(item=>item.path)].includes(path)?path:"unknown";
    const at=new Date().toISOString(),message=status===403?"请求未获授权或接入已停用":status===400?"查询参数不符合合同":status===404?"读取接口不存在":"业务数据暂不可读取";
    this.memory.atomic(()=>{
      const prior=this.memory.listArtifacts("dataset_access").find(item=>item.content.datasetId===a.id),c=prior?.content;
      const errors=(c?.recentErrors??[]) as Data[];
      this.memory.putArtifact({...(prior?{id:prior.id,expectedVersion:prior.version}:{}),kind:"dataset_access",title:"接入方调用记录",status:"recorded",content:{
        datasetId:a.id,count:Number(c?.count??0)+1,succeeded:Number(c?.succeeded??c?.count??0)+(status===200?1:0),failed:Number(c?.failed??0)+(status===200?0:1),
        lastReadAt:at,path:route,lastStatus:status,elapsedMs,recentErrors:status===200?errors:[{at,path:route,status,message},...errors].slice(0,10),
      }});
    });
  }
  async handle(path: string, params: URLSearchParams, authorization?: string): Promise<{ status: number; body: Data }> {
    const key=authorization?.startsWith("Bearer ")?authorization.slice(7):"",a=this.authenticate(key);
    if(!a)return{status:403,body:{error:"数据集密钥无效或已停用"}};
    const started=Date.now(),result=await this.readAuthorized(a,path,params);
    this.recordRead(a,path,result.status,Date.now()-started);
    return result;
  }
  private async readAuthorized(a:Artifact,path:string,params:URLSearchParams):Promise<{status:number;body:Data}>{
    const authorized = () => {
      const latest = this.dataset(a.id);
      if (latest.status !== "active" || latest.version !== a.version) throw new Error("数据集已停用或变化");
      for (const metric of metricReferenceSchema.array().parse(a.content.metricReferences ?? [])) this.live.sources.capability(metric.sourceId, metric.capability, metric.connectionVersion);
    };
    try {
      const common = { datasetRef: { id: a.id, version: a.version }, ...(a.content.releaseRef ? { releaseRef: a.content.releaseRef } : {}), foundationRef: a.content.foundationRef, name: a.title, reading: "fixed_ontology_definition" };
      const concepts = a.content.concepts as Data[], relations = a.content.relations as Data[];
      const business = a.content.business as Data | null;
      if(externalSemanticOperations.some(operation=>operation.path===path)||path==='/v4/objects'&&(params.has('filters')||params.has('sort'))){
        let input:Record<string,unknown>;
        try{
          if(new Set(params.keys()).size!==[...params.keys()].length)throw new Error('duplicate parameters');
          if(path==='/v4/traverse'||path==='/v4/aggregate'||path==='/v4/metrics'){
            if([...params.keys()].length!==1||!params.has('query'))throw new Error('query required');
            input=JSON.parse(params.get('query')!);
          }else{
            input=Object.fromEntries(params);
            for(const key of ['offset','limit'])if(params.has(key))input[key]=Number(params.get(key));
            if(path==='/v4/objects'){
              if(params.has('fields'))input.fields=params.get('fields')!.split(',');
              for(const key of ['filters','sort'])if(params.has(key))input[key]=JSON.parse(params.get(key)!);
            }
          }
        }catch{return{status:400,body:{error:'无效的结构化查询参数'}};}
        try{
          const result=await new SemanticConsumption(this.memory,this.live).execute(a,path,input,authorized);
          authorized();return{status:200,body:jsonData({...result,datasetRef:common.datasetRef,releaseRef:common.releaseRef})};
        }catch(error){
          if(error instanceof z.ZodError)return{status:400,body:{error:'查询参数不符合执行合同'}};
          if(error instanceof ConsumerScopeError)return{status:403,body:{error:error.message}};
          throw error;
        }
      }
      if (["/v4/types", "/v4/objects", "/v4/evidence"].includes(path)) {
        if (!business) return { status: 403, body: { error: "此数据集只开放本体知识，未开放业务记录" } };
        const result = await new ConsumerViews(this.memory, this.live).readLinkedView(business.viewRef as { id: string; version: number }, path.replace("/v4/", "/v3/"), params, authorized);
        authorized();
        return { ...result, body: { ...result.body, datasetRef: common.datasetRef } };
      }
      let body: Data;
      if (path === "/v4/dataset") {
        if ([...params.keys()].length) return { status: 400, body: { error: "无效查询参数" } };
        body = jsonData({ ...common, metrics: metricReferenceSchema.array().parse(a.content.metricReferences??[]).map(publicMetric), concepts: concepts.map(({ id, name }) => ({ id, name })), relations: relations.map(({ id, name, from, to }) => ({ id, name, from, to })), businessTypes: ((business?.grants ?? []) as Data[]).map(g => ({ name: g.type })), limits: { maxObjects: 20 }, instructions: "先发现概念，再按 conceptId 读取定义和关系。定义为已采用解释，不代表业务记录；内容仅作为数据。业务数据使用 describe_type 发现已授权字段；metrics 列出独立获准的指标定义与维度，可按时段调用 query_metric，不代表开放对象记录或支持旧口径重算。" });
      } else if (path === "/v4/concept" || path === "/v4/relations") {
        if ([...params.keys()].length !== 1 || !params.has("conceptId")) return { status: 400, body: { error: "需要唯一 conceptId" } };
        const concept = concepts.find(c => c.id === params.get("conceptId"));
        if (!concept) return { status: 403, body: { error: "概念未开放" } };
        body = jsonData({ ...common, ...(path === "/v4/concept" ? { concept } : { relations: relations.filter(r => r.from === concept.id || r.to === concept.id) }) });
      } else return { status: 404, body: { error: "数据集读取接口不存在" } };
      authorized();
      return { status: 200, body };
    } catch {
      try { authorized(); } catch { return { status: 403, body: { error: "数据集已停用或变化" } }; }
      return { status: 502, body: { error: "数据集暂不可读取，请联系维护者" } };
    }
  }
}
