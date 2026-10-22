import { dialog as engineDialog } from "./engine-ui.js";
import { showEngineBuilds } from "./engine-workspace.js";
import { technicalDetails } from "./ui-display.js";

export function createTaskCenter({ state, ui, $, node, button, navigate, setChatMode, dataActions, openDefinitions, isOnboarding }) {
function renderAgentTask() {
  let host=$("#agent-task-status");
  if(!host){host=node("aside","agent-task-status");host.id="agent-task-status";host.setAttribute("aria-label","Context OS 助手任务");const wrap=$(".agent-panel-shell .composer-wrap");if(wrap)wrap.insertBefore(host,$("#composer"));else $(".canvas-app").append(host);}
  const task=state.agentTask;host.hidden=!task||!!isOnboarding()||!!state.demo;
  if(host.hidden)return;
  const key=JSON.stringify(task);if(host.dataset.key===key)return;host.dataset.key=key;host.replaceChildren();
  const labels={queued:"等待执行",waiting:"等待输入",paused:"已暂停",running:"处理中",completed:"已完成",failed:"失败",stopped:"已停止",cancelled:"已取消",interrupted:"已中断"};
  host.append(node("span","",`${labels[task.status]||task.status} · ${task.title||"Context OS 助手"}`));
  if(task.stage)host.append(node("small","",task.stage));
  host.append(button("查看任务", "quiet-button",()=>{
    const d=engineDialog(task.title||"Context OS 助手任务");d.body.append(node("p","",`${labels[task.status]||task.status}${task.stage?` · ${task.stage}`:""}`));
    if(task.error)d.body.append(node("p","request-error",typeof task.error==="string"?task.error:task.error.message));
    const resultLabels={foundation:"本体定义",live_ontology:"数据对应",ontology_change:"本体变更",engine_build:"构建结果",engine_candidate:"构建候选",data_release:"发布结果",relation_correction:"关联纠正",mapping_change:"数据对应变更"};
    for(const result of task.resultRefs||[]){d.body.append(button(result.title||resultLabels[result.kind]||"任务成果","quiet-button",async()=>{d.close();if(result.kind==="data_release"||result.kind?.startsWith("release"))await navigate("consumption");else{await navigate("ontology");if(result.kind?.startsWith("engine"))showEngineBuilds(state,dataActions());else openDefinitions();}}));}
    d.body.append(technicalDetails(task));
    d.body.append(button("查看对话", "quiet-button",async()=>{d.close();if(task.page&&task.page!==ui.page)await navigate(task.page);setChatMode("history");}));
  }));
}
return { renderAgentTask };
}
