import { createHash } from "node:crypto";
import { z } from "zod";
import type { Data } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import type { FoundationService } from "./foundation.ts";
import { Workspace } from "./workspace.ts";
import { industryPacks } from "./industry-packs.ts";

const companySchema = z.object({
  name: z.string().trim().min(2).max(200), industry: z.string().max(100),
  business: z.string().trim().max(1500).default(""), region: z.string().trim().max(200).default(""),
  website: z.string().trim().max(2000).default(""), goal: z.string().trim().max(1500).default(""),
});
type Company = z.infer<typeof companySchema>;
interface SetupState {
  flow?: "engine" | "legacy";
  sourceKind?: "mcp" | "api" | "file" | "later";
  version: number; active: boolean; step: number; completedAt?: string;
  company: Company; packId?: string; foundationRef?: {id:string;version:number};
  lastOperation?: {id:string;hash:string};
}
const data = (value: unknown): Data => JSON.parse(JSON.stringify(value));
export class Onboarding {
  private memory: MemoryStore;
  private foundation: FoundationService;
  private task: () => string;
  constructor(memory: MemoryStore, foundation: FoundationService, task: () => string) {
    this.memory = memory; this.foundation = foundation; this.task = task;
  }
  private state(): SetupState {
    const saved = this.memory.getOnboarding();
    if (saved) return saved as unknown as SetupState;
    const profile = this.memory.listArtifacts("profile")[0];
    const current = this.foundation.read().current;
    return { version: 0, active: !profile && !current && !this.memory.listArtifacts("source").length && !this.memory.listArtifacts("ontology").length,
      flow: "engine", step: 1, company: this.currentCompany() };
  }
  private currentCompany(): Company {
    const statements = (this.memory.listArtifacts("profile")[0]?.content.statements ?? []) as Data[];
    const get = (...keys: string[]) => String(keys.map(key => statements.find(item => item.key === key && item.origin !== "suggestion")).find(Boolean)?.text ?? "");
    const current = this.foundation.read().current;
    const industry = get("company.industry");
    return { name: get("company.name", "company_name", "companyName", "name") || String((current?.content.enterprise as Data)?.name ?? ""),
      industry: industryPacks.find(pack => pack.id === industry || pack.name === industry)?.id ?? "",
      business: get("company.business", "business"), region: get("company.location"), website: get("company.website"), goal: get("company.goal") };
  }
  view() { return { ...this.state(), company: this.currentCompany(), currentProfileVersion: this.memory.listArtifacts("profile")[0]?.version ?? 0, packs: industryPacks }; }
  private expected(body: Record<string, unknown>) {
    const state = this.state();
    if (body.expectedVersion !== state.version) throw new Error("初始化进度已变化，请刷新后继续；输入可重新核对");
    return state;
  }
  private save(state: SetupState) { this.memory.saveOnboarding(data({ ...state, version: state.version + 1 })); }
  start(body: Record<string, unknown>) {
    const state = this.expected(body);
    if (body.flow !== undefined && body.flow !== "engine" && body.flow !== "legacy") throw new Error("无效的初始化流程");
    const flow = body.flow === "legacy" ? "legacy" : "engine";
    this.save({ ...state, flow, company: this.currentCompany(), active: true, step: flow !== state.flow || state.completedAt ? 1 : state.step });
  }
  suspend(body: Record<string, unknown>) { const state = this.expected(body); this.save({ ...state, active: false }); }
  step(body: Record<string, unknown>, configured: boolean) {
    const state = this.expected(body), step = Number(body.step);
    if (!Number.isInteger(step) || step < 1 || step > (state.flow === "engine" ? 2 : 5)) throw new Error("无效的初始化步骤");
    if (step > 1 && !configured) throw new Error("请先连接模型");
    if (step > 2 && (!state.company.name || !industryPacks.some(pack => pack.id === state.company.industry))) throw new Error("请先保存企业名称和所属行业");
    if (step > 3 && !this.foundation.read().adopted) throw new Error("请先选择并采用基础定义");
    this.save({ ...state, active: true, step });
  }
  company(body: Record<string, unknown>) {
    const state = this.expected(body), company = companySchema.parse(body);
    if (body.profileVersion !== (this.memory.listArtifacts("profile")[0]?.version ?? 0)) throw new Error("企业档案已在别处更新，请重新进入向导核对；未保存输入会保留为草稿");
    const pack = industryPacks.find(pack => pack.id === company.industry);
    if (!pack) throw new Error("请选择所属行业");
    if (company.website) {
      const url = new URL(company.website);
      if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error("官网地址应为不含凭据的 HTTP/HTTPS 地址");
    }
    const current = this.foundation.read().current;
    if (current && (current.content.enterprise as Data).name !== company.name) throw new Error("已有本体属于另一企业名称，请先在本体工作区处理名称纠正");
    this.memory.atomic(() => {
      const workspace = new Workspace(this.memory);
      const values = { "company.name": company.name, "company.industry": pack.name, "company.business": company.business,
        "company.location": company.region, "company.website": company.website, "company.goal": company.goal };
      for (const [key,value] of Object.entries(values)) {
        if (key === "company.business") workspace.clearOptionalProfile("business");
        const existing = (this.memory.listArtifacts("profile")[0]?.content.statements as Data[] | undefined)?.find(item => item.key === key);
        if (value && existing?.text !== value) workspace.editProfile(key,value);
        else if (!value && existing) workspace.clearOptionalProfile(key);
      }
      this.save({ ...state, flow: "legacy", company, active: true, step: body.stay === true ? 2 : 3 });
    });
  }
  researchText() {
    const {company} = this.state();
    if (!company.name || !company.industry) throw new Error("请先保存企业与行业信息");
    const name = industryPacks.find(p => p.id === company.industry)?.name ?? company.industry;
    return `我确认要研究的企业是“${company.name}”，所属领域“${name}”${company.region ? `，地区“${company.region}”` : ""}${company.website ? `，官网“${company.website}”` : ""}。请使用 enterprise-research Skill 和 KodaX 网页搜索能力，先核对同名企业，再读取公开来源，整理企业业务与行业背景。给出出处和未能核实的信息；行业通用知识不能当成该企业事实。仅研究和保存待核实的企业建议，不修改或采用基础本体、不连接系统。找不到可靠资料也明确说明。`;
  }
  applyPack(body: Record<string, unknown>) {
    const hash = createHash("sha256").update(JSON.stringify({packId:body.packId,concepts:body.concepts,baseVersion:body.baseVersion})).digest("hex");
    const previous = this.state();
    if (previous.lastOperation && previous.lastOperation.id === body.operationId) {
      if (previous.lastOperation.hash !== hash) throw new Error("同一操作不能更改选择内容");
      return;
    }
    const state = this.expected(body);
    const pack = industryPacks.find(pack => pack.id === body.packId);
    if (!pack || !state.company.name) throw new Error("请先保存企业，再选择行业包");
    const operationId = z.string().min(1).max(150).parse(body.operationId);
    const selected = z.array(z.object({ id:z.string(), name:z.string().trim().min(1).max(100), description:z.string().trim().min(1).max(1000) }).strict()).min(1).max(20).parse(body.concepts);
    if (new Set(selected.map(c=>c.id)).size !== selected.length || new Set(selected.map(c=>c.name)).size !== selected.length || selected.some(c=>!pack.concepts.some(p=>p.id===c.id))) throw new Error("行业概念选择无效或名称重复");
    const current = this.foundation.read().current;
    if ((current?.version ?? 0) !== body.baseVersion) throw new Error("本体已变化，请刷新后重新核对");
    if (current && current.status !== "adopted") throw new Error("已有待核对本体，请先在本体工作区处理，再添加行业定义");
    if (current && (current.content.enterprise as Data).name !== state.company.name) throw new Error("企业名称与当前本体不一致");
    this.memory.atomic(() => {
      const taskId = this.task();
      const context = this.memory.beginExecution(taskId);
      const prefix = `pack_${createHash("sha256").update(operationId).digest("hex").slice(0,16)}`;
      const quote = `我选择将“${pack.name}”行业包 v${pack.version} 用作“${state.company.name}”的初始建模模板；这些定义不是已核实的企业事实或实际业务数据。`;
      const message = this.memory.addMessage(taskId,"user",quote + "\n所选定义：\n" + selected.map(c=>`${c.name}：${c.description}`).join("\n"));
      const evidence = [{id:prefix,messageId:message.id,quote}, ...selected.map((c,i)=>({id:`${prefix}_${i}`,messageId:message.id,quote:`${c.name}：${c.description}`}))];
      const existing = (current?.content.concepts ?? []) as Data[];
      const ids = new Map(selected.map(c=>[c.id, String(existing.find(old=>old.name===c.name)?.id ??
        (existing.some(old=>old.id===c.id) ? `${c.id}_${prefix.slice(-8)}` : c.id))]));
      const additions = selected.filter(c=>!existing.some(old=>old.name===c.name));
      if (existing.length + additions.length > 30) throw new Error("基础概念超过当前 30 个上限，请减少所选概念");
      const relations = pack.relations.filter(r=>ids.has(r.from)&&ids.has(r.to));
      const priorRelations = (current?.content.relations ?? []) as Data[];
      const candidate = this.foundation.propose({baseVersion:current?.version??0,
        enterprise:{name:state.company.name,evidenceRefs:[prefix]},
        concepts:additions.map(c=>({...c,id:ids.get(c.id),evidenceRefs:[`${prefix}_${selected.indexOf(c)}`]})),
        relations:relations.filter(r=>!priorRelations.some(old=>old.from===ids.get(r.from)&&old.to===ids.get(r.to)&&old.name===r.name))
          .map(r=>({...r,id:priorRelations.some(old=>old.id===r.id)?`${r.id}_${prefix.slice(-8)}`:r.id,from:ids.get(r.from),to:ids.get(r.to),evidenceRefs:[prefix]})),
        evidence, unknowns:[{id:`${prefix}_scope`,description:`行业包“${pack.name}”只建立初始定义；业务适用范围、字段身份、实际实例和来源映射尚需企业资料确认。`,evidenceRefs:[prefix]}], conflicts:[],
      }, context, operationId, `industry-pack:${pack.id}:v${pack.version}`);
      const adopted = this.foundation.adopt(candidate.id,candidate.version);
      this.memory.attachArtifact(taskId,adopted);
      this.memory.complete(context,[adopted.id],"已采用所选行业初始定义，等待真实来源补充。");
      this.memory.endExecution(context);
      this.save({...state,active:true,step:4,packId:pack.id,foundationRef:{id:adopted.id,version:adopted.version},lastOperation:{id:operationId,hash}});
    });
  }
  complete(body: Record<string, unknown>, configured: boolean) {
    const state = this.expected(body);
    if (state.flow === "engine") {
      if (!configured) throw new Error("请先连接模型；数据来源可以稍后接入");
      const sourceKind = z.enum(["mcp", "api", "file", "later"]).parse(body.sourceKind ?? "later");
      this.save({...state, sourceKind, active:false, step:2, completedAt:new Date().toISOString()});
      return;
    }
    if (!configured || !state.company.name || !industryPacks.some(p=>p.id===state.company.industry) || !this.foundation.read().adopted)
      throw new Error("请先完成模型、企业与基础定义；来源可以稍后接入");
    this.save({...state,active:false,step:5,completedAt:new Date().toISOString()});
  }
}
