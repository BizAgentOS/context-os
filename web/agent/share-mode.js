// Single-file exports read an embedded demonstration snapshot. No request leaves
// the document; page navigation and example dialogue live only in this tab.
export function createShareMode(document) {
  const embedded = document.getElementById("dataengine-share-data");
  if (!embedded) return null;
  const data = JSON.parse(embedded.textContent);
  if (![1, 2].includes(data.formatVersion) || !data.pages || !data.routes)
    throw new Error("离线演示文件不完整，请重新导出。");
  document.documentElement.dataset.shareMode = "true";
  if (data.formatVersion === 1) {
    const previous = data.pages;
    data.pages = {
      setup: { ...previous.sources, ...previous.company },
      ontology: previous.ontology,
      consumption: previous.consumption,
    };
    for (const value of Object.values(data.pages)) {
      const ready = (page) =>
        value.pages?.find((item) => item.id === page)?.ready === true;
      value.pages = [
        {
          id: "setup",
          ready: ready("company") && ready("sources"),
          available: true,
        },
        { id: "ontology", ready: ready("ontology"), available: true },
        { id: "consumption", ready: ready("consumption"), available: true },
      ];
      value.layoutVersion = 2;
    }
    data.answers = { ...data.answers, setup: data.answers?.company };
  }
  const pageKey = (page) =>
    ["company", "sources"].includes(page) ? "setup" : page;
  let currentPage = "setup";
  let sequence = 0;
  const conversations = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const normalize = (value) => String(value).replace(/[\s？?。！!，,]/g, "");

  function snapshot(page = currentPage) {
    page = pageKey(page);
    if (!Object.hasOwn(data.pages, page))
      throw new Error("这份演示没有包含该页面。");
    currentPage = page;
    return {
      ...clone(data.pages[page]),
      token: "",
      currentPage: page,
      page,
      busy: false,
      streaming: "",
      pending: null,
      attention: [],
      model: { configured: true },
      demo: { offline: true },
      prompt: "",
      messages: clone(conversations.get(page) || []),
    };
  }

  function question(page) {
    return data.answers?.[page]?.question || "这一页展示了什么？";
  }

  async function request(path, body) {
    const [pathname, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    if (body !== undefined) {
      if (pathname === "/api/canvas/navigate") return snapshot(body.page);
      if (pathname === "/api/canvas/message") {
        const page = pageKey(body.page || currentPage);
        if (!Object.hasOwn(data.pages, page))
          throw new Error("这份演示没有包含该页面。");
        const example = data.answers?.[page];
        const matched =
          example && normalize(body.text) === normalize(example.question);
        const answer = matched
          ? `示例回答：${example.answer}`
          : `这是离线演示，当前不会调用 AI 或修改企业记忆。你可以浏览三个页面，或试问「${question(page)}」查看预置的示例回答。`;
        const messages = conversations.get(page) || [];
        messages.push(
          { id: `share-${++sequence}`, role: "user", content: body.text },
          { id: `share-${++sequence}`, role: "assistant", content: answer },
        );
        conversations.set(page, messages.slice(-6));
        return snapshot(page);
      }
      throw new Error(
        "离线演示仅供浏览；编辑、接入和发布需要在完整产品中操作。",
      );
    }
    if (pathname === "/api/canvas/bootstrap") return snapshot();
    if (pathname === "/api/canvas")
      return snapshot(params.get("page") || currentPage);

    let offset = 0;
    let limit = 18;
    if (pathname === "/api/objects") {
      offset = Number(params.get("offset") || 0);
      limit = Number(params.get("limit") || 18);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new Error("请选择有效的对象分页范围。");
      params.delete("offset");
      params.delete("limit");
    }
    params.sort();
    const key = `${pathname}${params.size ? `?${params}` : ""}`;
    if (!Object.hasOwn(data.routes, key))
      throw new Error("这份演示未包含该记录，可以返回查看其他企业记忆。");
    const result = clone(data.routes[key]);
    if (pathname === "/api/objects" && Array.isArray(result.result?.items)) {
      const collection = result.result;
      const all = collection.items;
      collection.items = all.slice(offset, offset + limit);
      collection.offset = offset;
      collection.truncated =
        offset > 0 || offset + collection.items.length < collection.total;
      collection.coverage = {
        ...collection.coverage,
        offset,
        shown: collection.items.length,
        complete: !collection.truncated,
      };
    }
    return result;
  }
  return { request, question };
}
